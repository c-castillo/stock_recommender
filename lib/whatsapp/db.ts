import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR =
  process.env.NODE_ENV === "production"
    ? "/tmp/.whatsapp"
    : path.join(process.cwd(), ".whatsapp");
const DB_PATH = path.join(DATA_DIR, "messages.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_groups (
      jid       TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      synced_at INTEGER,
      selected  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS wa_messages (
      id             TEXT PRIMARY KEY,
      jid            TEXT NOT NULL,
      sender         TEXT,
      body           TEXT,
      ts             INTEGER NOT NULL,
      media_type     TEXT,
      media_mime     TEXT,
      media_filename TEXT,
      media_path     TEXT,
      FOREIGN KEY (jid) REFERENCES wa_groups(jid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portfolio (
      ticker   TEXT PRIMARY KEY,
      shares   REAL NOT NULL,
      avg_cost REAL
    );

    CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_recommendations (
      ticker       TEXT PRIMARY KEY,
      company      TEXT NOT NULL DEFAULT '',
      action       TEXT NOT NULL,
      confidence   INTEGER NOT NULL,
      entry_price  TEXT,
      price_target TEXT,
      stop_loss    TEXT,
      reasoning    TEXT NOT NULL DEFAULT '',
      mentions     INTEGER NOT NULL DEFAULT 0,
      sources      TEXT NOT NULL DEFAULT '[]',
      generated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_jid ON wa_messages(jid);
    CREATE INDEX IF NOT EXISTS idx_messages_ts  ON wa_messages(ts DESC);
  `);

  // Migrations for existing databases
  const migrations = [
    "ALTER TABLE wa_groups ADD COLUMN selected INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE wa_messages ADD COLUMN media_type TEXT",
    "ALTER TABLE wa_messages ADD COLUMN media_mime TEXT",
    "ALTER TABLE wa_messages ADD COLUMN media_filename TEXT",
    "ALTER TABLE wa_messages ADD COLUMN media_path TEXT",
    "ALTER TABLE portfolio ADD COLUMN current_price REAL",
    "ALTER TABLE portfolio ADD COLUMN market_value REAL",
    "ALTER TABLE portfolio ADD COLUMN unrealized_pl REAL",
    "ALTER TABLE portfolio ADD COLUMN unrealized_pl_pc REAL",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
}

// ── Groups ──────────────────────────────────────────────────────────────────

export function upsertGroup(jid: string, name: string) {
  getDb()
    .prepare(
      `INSERT INTO wa_groups (jid, name, synced_at)
       VALUES (@jid, @name, @syncedAt)
       ON CONFLICT(jid) DO UPDATE SET name = @name, synced_at = @syncedAt`
    )
    .run({ jid, name, syncedAt: Date.now() });
}

export function upsertGroups(groups: { jid: string; name: string }[]) {
  const stmt = getDb().prepare(
    `INSERT INTO wa_groups (jid, name, synced_at)
     VALUES (@jid, @name, @syncedAt)
     ON CONFLICT(jid) DO UPDATE SET name = @name, synced_at = @syncedAt`
  );
  const run = getDb().transaction(() => {
    for (const g of groups) stmt.run({ ...g, syncedAt: Date.now() });
  });
  run();
}

export function listGroups(): { jid: string; name: string; synced_at: number; selected: boolean }[] {
  return (
    getDb()
      .prepare("SELECT jid, name, synced_at, selected FROM wa_groups ORDER BY name")
      .all() as { jid: string; name: string; synced_at: number; selected: number }[]
  ).map((g) => ({ ...g, selected: g.selected === 1 }));
}

export function setGroupSelected(jid: string, selected: boolean) {
  getDb()
    .prepare("UPDATE wa_groups SET selected = ? WHERE jid = ?")
    .run(selected ? 1 : 0, jid);
}

export function listSelectedJids(): string[] {
  return (
    getDb()
      .prepare("SELECT jid FROM wa_groups WHERE selected = 1")
      .all() as { jid: string }[]
  ).map((r) => r.jid);
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface MessageRow {
  id: string;
  jid: string;
  sender: string | null;
  body: string | null;
  ts: number;
  media_type?: string | null;
  media_mime?: string | null;
  media_filename?: string | null;
  media_path?: string | null;
}

export function insertMessage(msg: MessageRow) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO wa_messages
         (id, jid, sender, body, ts, media_type, media_mime, media_filename, media_path)
       VALUES
         (@id, @jid, @sender, @body, @ts, @media_type, @media_mime, @media_filename, @media_path)`
    )
    .run({
      media_type: null, media_mime: null, media_filename: null, media_path: null,
      ...msg,
    });
}

export function insertMessages(msgs: MessageRow[]) {
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO wa_messages
       (id, jid, sender, body, ts, media_type, media_mime, media_filename, media_path)
     VALUES
       (@id, @jid, @sender, @body, @ts, @media_type, @media_mime, @media_filename, @media_path)`
  );
  const run = getDb().transaction(() => {
    for (const m of msgs) {
      stmt.run({
        media_type: null, media_mime: null, media_filename: null, media_path: null,
        ...m,
      });
    }
  });
  run();
}

export function updateMessageMedia(
  id: string,
  media: { media_type: string; media_mime: string; media_filename: string; media_path: string }
) {
  getDb()
    .prepare(
      `UPDATE wa_messages
       SET media_type = @media_type, media_mime = @media_mime,
           media_filename = @media_filename, media_path = @media_path
       WHERE id = @id`
    )
    .run({ id, ...media });
}

/** Oldest stored message for a group — used to detect sync progress. */
export function getOldestMessage(jid: string): { id: string; ts: number } | null {
  return (
    getDb()
      .prepare("SELECT id, ts FROM wa_messages WHERE jid = ? ORDER BY ts ASC LIMIT 1")
      .get(jid) as { id: string; ts: number } | undefined
  ) ?? null;
}

/** Newest stored message for a group — used as a cursor to skip already-synced history. */
export function getNewestMessage(jid: string): { id: string; ts: number } | null {
  return (
    getDb()
      .prepare("SELECT id, ts FROM wa_messages WHERE jid = ? ORDER BY ts DESC LIMIT 1")
      .get(jid) as { id: string; ts: number } | undefined
  ) ?? null;
}

/** Count messages received after `sinceTs` (unix seconds) for a group. */
export function countMessagesSince(jid: string, sinceTs: number): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) as n FROM wa_messages WHERE jid = ? AND ts >= ?")
      .get(jid, sinceTs) as { n: number }
  ).n;
}

/** Count all messages stored for a group. */
export function countAllMessages(jid: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) as n FROM wa_messages WHERE jid = ?")
      .get(jid) as { n: number }
  ).n;
}

/** Count all media files downloaded for a group. */
export function countAllMedia(jid: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) as n FROM wa_messages WHERE jid = ? AND media_path IS NOT NULL")
      .get(jid) as { n: number }
  ).n;
}

/** Count media files downloaded for a group in the last N days. */
export function countMediaDownloaded(jid: string, sinceDaysAgo = 14): number {
  const since = Date.now() / 1000 - sinceDaysAgo * 86400;
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) as n FROM wa_messages WHERE jid = ? AND ts >= ? AND media_path IS NOT NULL"
      )
      .get(jid, since) as { n: number }
  ).n;
}

export function countMessages(jid?: string): number {
  if (jid) {
    return (
      getDb()
        .prepare("SELECT COUNT(*) as n FROM wa_messages WHERE jid = ?")
        .get(jid) as { n: number }
    ).n;
  }
  return (
    getDb()
      .prepare("SELECT COUNT(*) as n FROM wa_messages")
      .get() as { n: number }
  ).n;
}

// ── AI Analysis content loader ────────────────────────────────────────────────

export interface MessageForAnalysis {
  id: string;
  jid: string;
  group_name: string;
  sender: string | null;
  body: string | null;
  ts: number;
  media_type: string | null;
  media_mime: string | null;
  media_filename: string | null;
  media_path: string | null;
}

/**
 * Returns all messages from selected groups for the last N days,
 * enriched with group name and media metadata — for feeding to Claude.
 */
export function getContentForAnalysis(
  sinceDaysAgo = 21,
  maxMessages = 6000
): MessageForAnalysis[] {
  const since = Math.floor(Date.now() / 1000) - sinceDaysAgo * 86400;
  return getDb()
    .prepare(
      `SELECT m.id, m.jid, g.name AS group_name, m.sender, m.body, m.ts,
              m.media_type, m.media_mime, m.media_filename, m.media_path
       FROM wa_messages m
       JOIN wa_groups g ON m.jid = g.jid
       WHERE g.selected = 1 AND m.ts >= ?
       ORDER BY m.ts DESC
       LIMIT ?`
    )
    .all(since, maxMessages) as MessageForAnalysis[];
}

export function getRecentMessages(
  sinceDaysAgo = 7,
  /** If provided, only return messages from these group JIDs. Defaults to all selected groups. */
  jids?: string[]
): { id: string; jid: string; sender: string | null; body: string; ts: number }[] {
  const since = Date.now() / 1000 - sinceDaysAgo * 86400;
  const targetJids = jids ?? listSelectedJids();

  if (targetJids.length === 0) return [];

  const placeholders = targetJids.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT m.id, m.jid, m.sender, m.body, m.ts
       FROM wa_messages m
       WHERE m.ts >= ? AND m.body IS NOT NULL AND m.body != ''
         AND m.jid IN (${placeholders})
       ORDER BY m.ts DESC`
    )
    .all(since, ...targetJids) as {
    id: string;
    jid: string;
    sender: string | null;
    body: string;
    ts: number;
  }[];
}

// ── Portfolio ─────────────────────────────────────────────────────────────────

export interface PortfolioPosition {
  ticker: string;
  shares: number;
  avg_cost: number | null;
  current_price: number | null;
  market_value: number | null;
  unrealized_pl: number | null;
  unrealized_pl_pc: number | null;
}

export function listPortfolio(): PortfolioPosition[] {
  return getDb()
    .prepare("SELECT ticker, shares, avg_cost, current_price, market_value, unrealized_pl, unrealized_pl_pc FROM portfolio ORDER BY market_value DESC NULLS LAST")
    .all() as PortfolioPosition[];
}

export function upsertPosition(
  ticker: string,
  shares: number,
  avg_cost: number | null,
  current_price: number | null = null,
  market_value: number | null = null,
  unrealized_pl: number | null = null,
  unrealized_pl_pc: number | null = null,
) {
  getDb()
    .prepare(
      `INSERT INTO portfolio (ticker, shares, avg_cost, current_price, market_value, unrealized_pl, unrealized_pl_pc)
       VALUES (@ticker, @shares, @avg_cost, @current_price, @market_value, @unrealized_pl, @unrealized_pl_pc)
       ON CONFLICT(ticker) DO UPDATE SET
         shares = @shares, avg_cost = @avg_cost, current_price = @current_price,
         market_value = @market_value, unrealized_pl = @unrealized_pl, unrealized_pl_pc = @unrealized_pl_pc`
    )
    .run({ ticker: ticker.toUpperCase(), shares, avg_cost, current_price, market_value, unrealized_pl, unrealized_pl_pc });
}

export function deletePosition(ticker: string) {
  getDb()
    .prepare("DELETE FROM portfolio WHERE ticker = ?")
    .run(ticker.toUpperCase());
}

export function clearPortfolio() {
  getDb().prepare("DELETE FROM portfolio").run();
}

// ── Cash balance ──────────────────────────────────────────────────────────────

export function setCashBalance(amount: number) {
  getDb()
    .prepare(`INSERT INTO kv_store (key, value) VALUES ('cash_balance', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(amount));
}

export function getCashBalance(): number | null {
  const row = getDb()
    .prepare("SELECT value FROM kv_store WHERE key = 'cash_balance'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  const n = parseFloat(row.value);
  return isNaN(n) ? null : n;
}

// ── AI Recommendations ────────────────────────────────────────────────────────

export interface StoredAIRecommendation {
  ticker: string;
  company: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entryPrice: string | null;
  priceTarget: string | null;
  stopLoss: string | null;
  reasoning: string;
  mentions: number;
  sources: string[];
  generatedAt: number;
}

export function saveAiRecommendations(recs: Omit<StoredAIRecommendation, "generatedAt">[]): void {
  const db = getDb();
  const generatedAt = Math.floor(Date.now() / 1000);
  const insert = db.prepare(
    `INSERT INTO ai_recommendations
       (ticker, company, action, confidence, entry_price, price_target, stop_loss, reasoning, mentions, sources, generated_at)
     VALUES (@ticker, @company, @action, @confidence, @entry_price, @price_target, @stop_loss, @reasoning, @mentions, @sources, @generated_at)
     ON CONFLICT(ticker) DO UPDATE SET
       company=@company, action=@action, confidence=@confidence, entry_price=@entry_price,
       price_target=@price_target, stop_loss=@stop_loss, reasoning=@reasoning,
       mentions=@mentions, sources=@sources, generated_at=@generated_at`
  );
  db.transaction(() => {
    db.prepare("DELETE FROM ai_recommendations").run();
    for (const r of recs) {
      insert.run({
        ticker: r.ticker.toUpperCase(),
        company: r.company ?? "",
        action: r.action,
        confidence: r.confidence,
        entry_price: r.entryPrice ?? null,
        price_target: r.priceTarget ?? null,
        stop_loss: r.stopLoss ?? null,
        reasoning: r.reasoning ?? "",
        mentions: r.mentions ?? 0,
        sources: JSON.stringify(r.sources ?? []),
        generated_at: generatedAt,
      });
    }
  })();
}

export function loadAiRecommendations(): StoredAIRecommendation[] {
  return (
    getDb()
      .prepare("SELECT * FROM ai_recommendations ORDER BY confidence DESC")
      .all() as {
        ticker: string; company: string; action: string; confidence: number;
        entry_price: string | null; price_target: string | null; stop_loss: string | null;
        reasoning: string; mentions: number; sources: string; generated_at: number;
      }[]
  ).map((r) => ({
    ticker: r.ticker,
    company: r.company,
    action: r.action as "BUY" | "SELL" | "HOLD",
    confidence: r.confidence,
    entryPrice: r.entry_price,
    priceTarget: r.price_target,
    stopLoss: r.stop_loss,
    reasoning: r.reasoning,
    mentions: r.mentions,
    sources: JSON.parse(r.sources) as string[],
    generatedAt: r.generated_at,
  }));
}

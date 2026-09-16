import Database from "better-sqlite3";
import { pinnedAnalysisGroups } from "./analysis-groups";
import { isContentlessNoise } from "./noise";
import { surrogateMessageId } from "./msg-id";
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
    applyPinnedSelection(_db);
  }
  return _db;
}

/**
 * Reassert the pinned analysis scope on every database open.
 *
 * Declarative scope beats a clicked checkbox: a resync, a restored backup or a
 * stray UPDATE cannot widen what the analyst reads. No-ops when the pinned list
 * is empty (ANALYSIS_GROUPS=""), which hands control back to the dashboard.
 */
function applyPinnedSelection(db: Database.Database) {
  const pinned = pinnedAnalysisGroups();
  if (pinned.length === 0) return;

  const wanted = new Set(pinned);
  const rows = db.prepare("SELECT jid, name, selected FROM wa_groups").all() as {
    jid: string;
    name: string;
    selected: number;
  }[];
  if (rows.length === 0) return; // groups not discovered yet

  const update = db.prepare("UPDATE wa_groups SET selected = ? WHERE jid = ?");
  let matched = 0;
  const run = db.transaction(() => {
    for (const g of rows) {
      const want = wanted.has(g.name) || wanted.has(g.jid) ? 1 : 0;
      if (want === 1) matched++;
      if (g.selected !== want) update.run(want, g.jid);
    }
  });
  run();

  if (matched === 0) {
    // Loud, because the analysis would otherwise run on an empty corpus and
    // report "thin content" rather than a misconfiguration.
    console.warn(
      `[whatsapp] ANALYSIS scope: none of the pinned groups matched a synced group ` +
        `(${pinned.join(", ")}). Check names in lib/whatsapp/analysis-groups.ts.`
    );
  }
}

function initSchema(db: Database.Database) {
  db.exec(`
    -- The selected column gates what the ANALYSIS reads (getContentForAnalysis),
    -- not what gets stored. It defaults to 0 because refreshGroups() enumerates
    -- every chat in the account: with a default of 1 every family, work and
    -- tennis-league group silently joined the corpus, and a session could come
    -- back "thin" with 29 soccer messages and 5 from the actual trading channel.
    -- Selecting a group is a deliberate act.
    CREATE TABLE IF NOT EXISTS wa_groups (
      jid       TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      synced_at INTEGER,
      selected  INTEGER NOT NULL DEFAULT 0
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
      dr_cs_add      INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS portfolio_history (
      date         TEXT PRIMARY KEY,
      total_value  REAL NOT NULL,
      market_value REAL NOT NULL,
      cash_balance REAL NOT NULL
    );

    -- Persistent ledger of Dr CS ADD signals. Dr CS's adds don't always arrive
    -- as "+TICKER" text (they come via chat/voice/images), so the analysis
    -- pipeline would otherwise lose them every run and re-derive a SELL from
    -- MM200/loss rules. Rows here are injected into every synthesis run as
    -- [★ DR CS ADD] until explicitly deactivated (Dr CS SELL / thesis closed).
    CREATE TABLE IF NOT EXISTS dr_cs_adds (
      ticker      TEXT PRIMARY KEY,
      entry_price TEXT,
      note        TEXT,
      added_on    TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL
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
    // Cached Haiku digest of a chart image / PDF, produced once at ingestion so
    // the synthesis call never re-sends raw base64 media. JSON-encoded.
    "ALTER TABLE wa_messages ADD COLUMN media_digest TEXT",
    // 1 when the message is a Dr CS watchlist add ("+TICKER"). Set at insert
    // time so the flag survives without re-deriving it from the body.
    "ALTER TABLE wa_messages ADD COLUMN dr_cs_add INTEGER NOT NULL DEFAULT 0",
    // Model-assigned relevance: 1 = can inform a recommendation, 0 = noise,
    // NULL = not yet classified. NULL reads as relevant so a message is never
    // hidden merely because the classifier has not caught up.
    "ALTER TABLE wa_messages ADD COLUMN relevance INTEGER",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
}

// ── Groups ──────────────────────────────────────────────────────────────────

// Discovery writes `selected = 0` explicitly rather than leaning on the column
// default, so a newly-enumerated chat can never join the analysis corpus on its
// own — regardless of what an older migrated database defaulted to. ON CONFLICT
// deliberately does NOT touch `selected`: a group you already chose keeps your
// choice across every resync.
const UPSERT_GROUP_SQL = `INSERT INTO wa_groups (jid, name, synced_at, selected)
   VALUES (@jid, @name, @syncedAt, 0)
   ON CONFLICT(jid) DO UPDATE SET name = @name, synced_at = @syncedAt`;

export function upsertGroup(jid: string, name: string) {
  getDb().prepare(UPSERT_GROUP_SQL).run({ jid, name, syncedAt: Date.now() });
}

export function upsertGroups(groups: { jid: string; name: string }[]) {
  const stmt = getDb().prepare(UPSERT_GROUP_SQL);
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

/** How many groups the analysis is actually allowed to read. */
export function countSelectedGroups(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS n FROM wa_groups WHERE selected = 1").get() as {
      n: number;
    }
  ).n;
}

export function listSelectedJids(): string[] {
  return (
    getDb()
      .prepare("SELECT jid FROM wa_groups WHERE selected = 1")
      .all() as { jid: string }[]
  ).map((r) => r.jid);
}

/** JIDs of groups matching any of the given names or JIDs. */
export function listGroupJidsByName(names: string[]): string[] {
  if (names.length === 0) return [];
  const wanted = new Set(names);
  return (
    getDb().prepare("SELECT jid, name FROM wa_groups").all() as {
      jid: string;
      name: string;
    }[]
  )
    .filter((g) => wanted.has(g.name) || wanted.has(g.jid))
    .map((g) => g.jid);
}

/**
 * Messages eligible for noise pruning: text-only, never a Dr CS ADD, and with
 * no media or cached digest. The exclusions are the point — charts, PDFs and
 * ADDs are the corpus's highest-value content and must never reach a delete set.
 */
export function listMessagesForPruning(
  jids: string[]
): { id: string; body: string | null }[] {
  if (jids.length === 0) return [];
  const ph = jids.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT id, body FROM wa_messages
       WHERE jid IN (${ph})
         AND dr_cs_add = 0
         AND media_path IS NULL
         AND media_digest IS NULL`
    )
    .all(...jids) as { id: string; body: string | null }[];
}

/** Delete messages by id, chunked to stay under SQLite's variable limit. */
export function deleteMessagesByIds(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  let removed = 0;
  const run = db.transaction((batch: string[]) => {
    const ph = batch.map(() => "?").join(",");
    removed += db.prepare(`DELETE FROM wa_messages WHERE id IN (${ph})`).run(...batch).changes;
  });
  for (let i = 0; i < ids.length; i += 500) run(ids.slice(i, i + 500));
  return removed;
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

/**
 * A Dr CS watchlist add: a message whose body starts with "+" followed by a
 * ticker (optionally after a space, e.g. "+VIAV" or "+ CTVA"). Excludes things
 * like "+55% arriba" where a digit follows the "+".
 */
const DR_CS_ADD_RE = /^\+\s*[A-Za-z]/;

export function isDrCsAdd(body: string | null | undefined): boolean {
  return body != null && DR_CS_ADD_RE.test(body.trim());
}

/**
 * Extract the ticker(s) an ADD message names, with the level if one is given.
 * One message can carry several ("+ CTVA\n+ ROST").
 *
 * Stricter than DR_CS_ADD_RE on purpose: the ticker must be UPPERCASE, so
 * ordinary chat starting with a plus ("+ muy bueno") never reaches the ledger.
 * The flag column stays as permissive as it was — only what gets persisted as
 * a standing signal is tightened.
 */
const DR_CS_ADD_LINE_RE = /^\+\s*([A-Z]{1,6})\b\s*(.*)$/;

export function parseDrCsAdds(
  body: string | null | undefined
): { ticker: string; entryPrice: string | null }[] {
  if (!body) return [];
  const out: { ticker: string; entryPrice: string | null }[] = [];
  const seen = new Set<string>();
  for (const raw of body.split("\n")) {
    const m = raw.trim().match(DR_CS_ADD_LINE_RE);
    if (!m) continue;
    const ticker = m[1].toUpperCase();
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    // "+GLW 174" → "174"; "+SNDK 600s" → "600s"; "+DOW (stock)" → null.
    const priceM = (m[2] ?? "").trim().match(/^\$?([\d][\w.,]*)/);
    out.push({ ticker, entryPrice: priceM ? priceM[1] : null });
  }
  return out;
}

// UPSERT (not INSERT OR IGNORE): a re-sync of an already-stored message must be
// able to backfill media it previously failed to download. On conflict we fill
// any media column the new row provides (COALESCE keeps the existing value when
// the new one is null) and refresh the body — but never blank out media we
// already have.
const INSERT_MESSAGE_SQL = `INSERT INTO wa_messages
     (id, jid, sender, body, ts, media_type, media_mime, media_filename, media_path, dr_cs_add)
   VALUES
     (@id, @jid, @sender, @body, @ts, @media_type, @media_mime, @media_filename, @media_path, @dr_cs_add)
   ON CONFLICT(id) DO UPDATE SET
     media_type     = COALESCE(excluded.media_type, media_type),
     media_mime     = COALESCE(excluded.media_mime, media_mime),
     media_filename = COALESCE(excluded.media_filename, media_filename),
     media_path     = COALESCE(excluded.media_path, media_path),
     body           = COALESCE(excluded.body, body),
     dr_cs_add      = excluded.dr_cs_add`;

function insertParams(msg: MessageRow) {
  return {
    media_type: null, media_mime: null, media_filename: null, media_path: null,
    ...msg,
    // A NULL id is not a primary key SQLite will enforce — the row becomes
    // unreachable by id and immune to ON CONFLICT dedupe. Substitute a
    // deterministic surrogate so every row stays addressable.
    id: msg.id || surrogateMessageId(msg),
    dr_cs_add: isDrCsAdd(msg.body) ? 1 : 0,
  };
}

/**
 * Persist any ADD the message carries into the standing ledger.
 *
 * Without this the flag column was the only trace: an ADD lived exactly as long
 * as the 7-day analysis window, then vanished, while the pipeline's own SELL on
 * the same ticker persisted in wiki/ forever. "+GLW 174" (Jul 15) and "+MU"
 * (Jun 29) were both lost that way and both ended up carrying high-confidence
 * SELLs the playbook would otherwise have forbidden.
 */
function persistDrCsAdds(msg: MessageRow) {
  if (!isDrCsAdd(msg.body)) return;
  const addedOn = new Date(msg.ts * 1000).toISOString().slice(0, 10);
  for (const { ticker, entryPrice } of parseDrCsAdds(msg.body)) {
    recordDrCsAddIfNew({ ticker, entryPrice, addedOn, note: "auto: +TICKER in corpus" });
  }
}

/**
 * Refuse to store a message that cannot inform a recommendation.
 *
 * Only provably contentless bodies are dropped — stickers, system placeholders,
 * bare emoji, greetings, pure @-mentions (see lib/whatsapp/noise.ts). Anything
 * carrying media is always kept regardless: an uncaptioned chart arrives with a
 * body like "[image]" and is among the most valuable content in the corpus.
 * Judgement calls are never made here; they are marked, not dropped, by the
 * model pass in lib/ai/relevance.ts.
 */
function shouldStore(msg: MessageRow): boolean {
  if (msg.media_path || msg.media_type) return true;
  return !isContentlessNoise(msg.body);
}

export function insertMessage(msg: MessageRow) {
  if (!shouldStore(msg)) return;
  getDb().prepare(INSERT_MESSAGE_SQL).run(insertParams(msg));
  persistDrCsAdds(msg);
}

export function insertMessages(msgs: MessageRow[]) {
  const stmt = getDb().prepare(INSERT_MESSAGE_SQL);
  const storable = msgs.filter(shouldStore);
  const run = getDb().transaction(() => {
    for (const m of storable) {
      stmt.run(insertParams(m));
      persistDrCsAdds(m);
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

/**
 * Every message already stored for a group at or after `sinceTs`, mapped to
 * whether its media file made it to disk.
 *
 * The sync job uses this to skip messages it already has BEFORE downloading
 * their media. The `msg.timestamp < newestStoredTs` cursor cannot do that:
 * everything at or newer than the newest stored timestamp falls through, and
 * since the live `message_create` listener stores exactly those as they
 * arrive, every sync re-downloaded the whole recent window's media over CDP.
 *
 * The media flag matters: a row whose download failed at receive time has a
 * NULL media_path, and re-running it is how that file is recovered —
 * INSERT_MESSAGE_SQL's COALESCE upsert backfills the columns. Only rows that
 * are already complete are safe to skip outright.
 */
export function getStoredMediaState(
  jid: string,
  sinceTs: number
): Map<string, boolean> {
  const rows = getDb()
    .prepare("SELECT id, media_path FROM wa_messages WHERE jid = ? AND ts >= ?")
    .all(jid, sinceTs) as { id: string; media_path: string | null }[];
  return new Map(rows.map((r) => [r.id, r.media_path !== null]));
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
  media_digest: string | null;
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
              m.media_type, m.media_mime, m.media_filename, m.media_path, m.media_digest
       FROM wa_messages m
       JOIN wa_groups g ON m.jid = g.jid
       WHERE g.selected = 1 AND m.ts >= ?
         AND (m.relevance IS NULL OR m.relevance = 1)
       ORDER BY m.ts DESC
       LIMIT ?`
    )
    .all(since, maxMessages) as MessageForAnalysis[];
}

/**
 * Drop cached digests inside a window so they are regenerated.
 *
 * Needed when the digest SCHEMA changes: an old digest is still valid JSON and
 * ensureMediaDigests only fills rows where media_digest IS NULL, so a new field
 * would otherwise never appear on already-digested charts.
 * Returns the number of digests cleared.
 */
export function clearMediaDigests(sinceDaysAgo: number, selectedOnly = true): number {
  const since = Math.floor(Date.now() / 1000) - sinceDaysAgo * 86400;
  const sql = selectedOnly
    ? `UPDATE wa_messages SET media_digest = NULL
       WHERE media_digest IS NOT NULL AND media_path IS NOT NULL AND ts >= ?
         AND jid IN (SELECT jid FROM wa_groups WHERE selected = 1)`
    : `UPDATE wa_messages SET media_digest = NULL
       WHERE media_digest IS NOT NULL AND media_path IS NOT NULL AND ts >= ?`;
  return getDb().prepare(sql).run(since).changes;
}

/** Count digested media in a window — for reporting before a re-digest. */
export function countDigestedMedia(sinceDaysAgo: number): number {
  const since = Math.floor(Date.now() / 1000) - sinceDaysAgo * 86400;
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM wa_messages
         WHERE media_digest IS NOT NULL AND media_path IS NOT NULL AND ts >= ?
           AND jid IN (SELECT jid FROM wa_groups WHERE selected = 1)`
      )
      .get(since) as { n: number }
  ).n;
}

/** Persist a Haiku-generated digest for a single media message (Stage 1). */
export function setMediaDigest(id: string, digest: string): void {
  getDb()
    .prepare("UPDATE wa_messages SET media_digest = ? WHERE id = ?")
    .run(digest, id);
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

// ── Portfolio goal ────────────────────────────────────────────────────────────

export interface PortfolioGoal {
  amount: number;
  deadline: string; // ISO date string, e.g. "2026-12-31"
}

export function setPortfolioGoal(goal: PortfolioGoal) {
  getDb()
    .prepare(`INSERT INTO kv_store (key, value) VALUES ('portfolio_goal', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(goal));
}

export function getPortfolioGoal(): PortfolioGoal | null {
  const row = getDb()
    .prepare("SELECT value FROM kv_store WHERE key = 'portfolio_goal'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as PortfolioGoal; } catch { return null; }
}

// ── Performance anchor ────────────────────────────────────────────────────────

/**
 * What the broker knows and the local snapshots don't: the year-start value and
 * every cash movement since. Without the flows a portfolio that grew only
 * because money was added reads as a gain, so returns are computed from this
 * anchor plus the live market value. Refreshed from the Zesty MCP tools
 * (get_portfolio_history + get_movements) — see lib/market/performance.ts.
 */
export interface PerformanceAnchor {
  /** When this anchor was last refreshed from the broker (ISO date). */
  asOf: string;
  /** Last close of the prior year, and its value. */
  yearStartDate: string;
  yearStartValue: number;
  /** Deposits (+) and withdrawals (−) since yearStartDate, in USD. */
  flows: { date: string; amount: number }[];
  /** Weekly total-value series, so 3M/6M windows have a start value the local
   *  daily snapshots (which begin mid-year and miss days) cannot provide. */
  series?: { date: string; value: number }[];
  /** Highest total value so far this year, per the broker's own history. */
  peak: { date: string; value: number };
  source: string;
}

export function setPerformanceAnchor(anchor: PerformanceAnchor) {
  getDb()
    .prepare(`INSERT INTO kv_store (key, value) VALUES ('performance_anchor', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(anchor));
}

export function getPerformanceAnchor(): PerformanceAnchor | null {
  const row = getDb()
    .prepare("SELECT value FROM kv_store WHERE key = 'performance_anchor'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as PerformanceAnchor; } catch { return null; }
}

// ── Analysis result cache ─────────────────────────────────────────────────────

export interface AnalysisCacheEntry {
  /** sha256 of the analysis inputs (messages + media digests + portfolio). */
  hash: string;
  /** epoch ms when the report was generated. */
  createdAt: number;
  /** The streamed synthesis narrative (Markdown). */
  narrative: string;
  /** Structured recommendations extracted from the narrative. */
  recommendations: unknown[];
  /** Stats banner emitted before the report. */
  stats: unknown;
}

export function getAnalysisCache(): AnalysisCacheEntry | null {
  const row = getDb()
    .prepare("SELECT value FROM kv_store WHERE key = 'analysis_cache'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as AnalysisCacheEntry; } catch { return null; }
}

export function setAnalysisCache(entry: AnalysisCacheEntry): void {
  getDb()
    .prepare(`INSERT INTO kv_store (key, value) VALUES ('analysis_cache', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(entry));
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

// ── Portfolio history ─────────────────────────────────────────────────────────

export interface PortfolioSnapshot {
  date: string;         // 'YYYY-MM-DD'
  total_value: number;  // market_value + cash_balance
  market_value: number;
  cash_balance: number;
}

export function upsertPortfolioSnapshot(snapshot: PortfolioSnapshot): void {
  getDb()
    .prepare(
      `INSERT INTO portfolio_history (date, total_value, market_value, cash_balance)
       VALUES (@date, @total_value, @market_value, @cash_balance)
       ON CONFLICT(date) DO UPDATE SET
         total_value  = @total_value,
         market_value = @market_value,
         cash_balance = @cash_balance`
    )
    .run(snapshot);
}

export function getPortfolioHistory(days = 90): PortfolioSnapshot[] {
  return (
    getDb()
      .prepare(
        `SELECT date, total_value, market_value, cash_balance
         FROM portfolio_history
         ORDER BY date DESC
         LIMIT ?`
      )
      .all(days) as PortfolioSnapshot[]
  ).reverse();
}

// ── AI Recommendations ────────────────────────────────────────────────────────

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

/** Legacy rows whose id never got written. Addressed by rowid, not id. */
export function listNullIdMessages(): {
  rowid: number;
  jid: string;
  ts: number;
  sender: string | null;
  body: string | null;
}[] {
  return getDb()
    .prepare("SELECT rowid, jid, ts, sender, body FROM wa_messages WHERE id IS NULL")
    .all() as { rowid: number; jid: string; ts: number; sender: string | null; body: string | null }[];
}

/** Set a row's id by rowid. Returns false when the id is already taken. */
export function assignMessageId(rowid: number, id: string): boolean {
  try {
    return getDb().prepare("UPDATE wa_messages SET id = ? WHERE rowid = ?").run(id, rowid).changes > 0;
  } catch {
    return false; // UNIQUE collision: an identical message already has this id
  }
}

/**
 * Remove duplicates among RECOVERED rows only, keeping the earliest of each set.
 *
 * Scoped to `recovered_%` deliberately. Two genuinely distinct messages can
 * share (jid, ts, body, sender) — the same short reply sent twice in one second
 * — and those carry real, distinct WhatsApp ids. Only rows that lost their id,
 * and therefore could never dedupe on insert, are candidates here.
 */
export function dedupeSurrogateRows(): number {
  return getDb()
    .prepare(
      `DELETE FROM wa_messages
       WHERE id LIKE 'recovered\\_%' ESCAPE '\\'
         AND rowid NOT IN (
           SELECT MIN(rowid) FROM wa_messages
           WHERE id LIKE 'recovered\\_%' ESCAPE '\\'
           GROUP BY jid, ts, COALESCE(body, ''), COALESCE(sender, '')
         )`
    )
    .run().changes;
}

// ── Relevance (model-assigned) ────────────────────────────────────────────────

/** Text messages in the given groups that have not been classified yet. */
export function listUnclassifiedMessages(
  jids: string[],
  limit = 500
): { id: string; body: string }[] {
  if (jids.length === 0) return [];
  const ph = jids.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT id, body FROM wa_messages
       WHERE jid IN (${ph})
         AND relevance IS NULL
         AND dr_cs_add = 0
         AND media_path IS NULL
         AND body IS NOT NULL AND body != ''
       ORDER BY ts DESC
       LIMIT ?`
    )
    .all(...jids, limit) as { id: string; body: string }[];
}

/** Persist relevance verdicts. */
export function setRelevance(verdicts: { id: string; relevant: boolean }[]): number {
  if (verdicts.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare("UPDATE wa_messages SET relevance = ? WHERE id = ?");
  let n = 0;
  const run = db.transaction(() => {
    for (const v of verdicts) n += stmt.run(v.relevant ? 1 : 0, v.id).changes;
  });
  run();
  return n;
}

/** Counts by relevance state for the given groups — for reporting. */
export function relevanceStats(jids: string[]): { relevant: number; noise: number; pending: number } {
  if (jids.length === 0) return { relevant: 0, noise: 0, pending: 0 };
  const ph = jids.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN relevance = 1 THEN 1 ELSE 0 END) AS relevant,
         SUM(CASE WHEN relevance = 0 THEN 1 ELSE 0 END) AS noise,
         SUM(CASE WHEN relevance IS NULL THEN 1 ELSE 0 END) AS pending
       FROM wa_messages WHERE jid IN (${ph})`
    )
    .get(...jids) as { relevant: number | null; noise: number | null; pending: number | null };
  return {
    relevant: row.relevant ?? 0,
    noise: row.noise ?? 0,
    pending: row.pending ?? 0,
  };
}

// ── Dr CS ADD ledger ──────────────────────────────────────────────────────────

export interface DrCsAddEntry {
  ticker: string;
  entryPrice: string | null;
  note: string | null;
  addedOn: string | null; // 'YYYY-MM-DD'
  active: boolean;
}

/** Record (or re-activate) a Dr CS ADD. Idempotent per ticker. */
export function recordDrCsAdd(e: {
  ticker: string;
  entryPrice?: string | null;
  note?: string | null;
  addedOn?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO dr_cs_adds (ticker, entry_price, note, added_on, active, created_at)
       VALUES (@ticker, @entry_price, @note, @added_on, 1, @created_at)
       ON CONFLICT(ticker) DO UPDATE SET
         entry_price = COALESCE(@entry_price, entry_price),
         note        = COALESCE(@note, note),
         added_on    = COALESCE(@added_on, added_on),
         active      = 1`
    )
    .run({
      ticker: e.ticker.toUpperCase(),
      entry_price: e.entryPrice ?? null,
      note: e.note ?? null,
      added_on: e.addedOn ?? new Date().toISOString().slice(0, 10),
      created_at: Date.now(),
    });
}

/**
 * Record an ADD detected in the corpus WITHOUT disturbing curated state.
 *
 * ON CONFLICT DO NOTHING, unlike recordDrCsAdd's upsert: a hand-corrected entry
 * price, a written note, or a deliberate deactivation must always win over
 * re-ingestion of the same old message. Returns true if a new row was created.
 */
export function recordDrCsAddIfNew(e: {
  ticker: string;
  entryPrice?: string | null;
  note?: string | null;
  addedOn?: string | null;
  active?: boolean;
}): boolean {
  const info = getDb()
    .prepare(
      `INSERT INTO dr_cs_adds (ticker, entry_price, note, added_on, active, created_at)
       VALUES (@ticker, @entry_price, @note, @added_on, @active, @created_at)
       ON CONFLICT(ticker) DO NOTHING`
    )
    .run({
      ticker: e.ticker.toUpperCase(),
      entry_price: e.entryPrice ?? null,
      note: e.note ?? null,
      added_on: e.addedOn ?? new Date().toISOString().slice(0, 10),
      active: e.active === false ? 0 : 1,
      created_at: Date.now(),
    });
  return info.changes > 0;
}

/**
 * Every stored message flagged as a Dr CS ADD, oldest first. Used by the
 * ledger backfill to recover ADDs that were ingested before persistence
 * existed and so only ever set the flag column.
 */
export function listDrCsAddMessages(): { body: string | null; ts: number }[] {
  return getDb()
    .prepare("SELECT body, ts FROM wa_messages WHERE dr_cs_add = 1 ORDER BY ts ASC")
    .all() as { body: string | null; ts: number }[];
}

/** Deactivate a Dr CS ADD (Dr CS issued a SELL / thesis closed). */
export function deactivateDrCsAdd(ticker: string): void {
  getDb().prepare("UPDATE dr_cs_adds SET active = 0 WHERE ticker = ?").run(ticker.toUpperCase());
}

/** Active ADDs, newest first — injected into every analysis run. */
export function listActiveDrCsAdds(): DrCsAddEntry[] {
  return (
    getDb()
      .prepare(
        "SELECT ticker, entry_price, note, added_on, active FROM dr_cs_adds WHERE active = 1 ORDER BY added_on DESC, ticker"
      )
      .all() as {
        ticker: string; entry_price: string | null; note: string | null; added_on: string | null; active: number;
      }[]
  ).map((r) => ({
    ticker: r.ticker,
    entryPrice: r.entry_price,
    note: r.note,
    addedOn: r.added_on,
    active: r.active === 1,
  }));
}

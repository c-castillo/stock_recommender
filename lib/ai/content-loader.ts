/**
 * Loads downloaded WhatsApp content for analysis.
 *
 * Media is NOT sent as raw base64 anymore — chart images and PDFs are digested
 * once at ingestion (see media-digest.ts) and surfaced here as compact text.
 * This module exposes the filtered rows so the caller can rank/truncate before
 * rendering, then provides the render helpers.
 */

import {
  getContentForAnalysis,
  isMainAnalystAdd,
  isMainAnalyst,
  mainAnalystAliases,
  listActiveMainAnalystAdds,
  type MainAnalystAddEntry,
  type MessageForAnalysis,
  getDigestsWithIdeas,
  getDigestsWithMacro,
} from "@/lib/whatsapp/db";
import { fetchCurrentPrices } from "@/lib/market/quotes";
import { fetchMa200Slopes } from "@/lib/ma200";
import type { MacroNote, ReportIdea } from "@/lib/ai/media-prompts";
import { isLocalListing, normalizeIdeas } from "@/lib/market/tickers";
import { MACRO_TOPICS, macroTopicsOf, normalizeMacroTopic } from "@/lib/market/macro-topics";

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_TEXT_MESSAGES = 3500;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AnalysisStats {
  textMessages: number;
  images: number;
  documents: number;
  groups: string[];
}

export interface AnalysisInputs {
  /** Relevance-filtered text messages, newest first. */
  textRows: MessageForAnalysis[];
  /** Media rows that already have a cached digest, newest first. */
  mediaRows: MessageForAnalysis[];
  stats: AnalysisStats;
}

// ── Relevance filter ──────────────────────────────────────────────────────────

const FINANCIAL_RE =
  /\b([A-Z]{1,5})\b|\$[0-9]|%|precio|target|stop|soporte|resistencia|comprar?|vender?|invertir|accion|bolsa|mercado|etf|fondo|divisa|dolar|peso|bitcoin|crypto|chart|grafico|reporte|earnings|resultado|dividendo|ticker|long|short|bull|bear|fibonacci|ma\s*\d{2,3}|mm\s*\d{2,3}|análisis|analisis|pd[fF]|informe|recomenda/i;

const IRRELEVANT_RE = /^[\s\p{Emoji}‍️]*$/u;

const GREETING_RE =
  /^(hola|buenas?(\s+(días?|tardes?|noches?))?|saludos?|buenos días?|buen[ao]s|hi|hello|hey|gracias|de nada|ok|okay|si|sí|no|claro|exacto|correcto|verdad|jaja+|jeje+|lol|xd|😂|👍|👋|🙌|🤣|feliz|bienvenid|hasta luego|nos vemos|ciao|adios|adiós|chao|que tal|como están?|como van?|buen fin|buen finde)[\s!.,?]*$/i;

function isRelevantMessage(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (FINANCIAL_RE.test(trimmed)) return true;
  if (IRRELEVANT_RE.test(trimmed)) return false;
  if (GREETING_RE.test(trimmed)) return false;
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString("es-CL", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

// ── Main loader ───────────────────────────────────────────────────────────────

export function loadAnalysisInputs(sinceDaysAgo = 7): AnalysisInputs {
  const rows = getContentForAnalysis(sinceDaysAgo, MAX_TEXT_MESSAGES);

  const textRows = rows.filter((r) => r.body && isRelevantMessage(r.body));
  // Only media that has already been digested (Stage 1) is usable here.
  const mediaRows = rows.filter(
    (r) =>
      r.media_digest != null &&
      (r.media_type === "image" || r.media_type === "document")
  );

  const groups = [...new Set(rows.map((r) => r.group_name))];

  return {
    textRows,
    mediaRows,
    stats: {
      textMessages: textRows.length,
      images: mediaRows.filter((r) => r.media_type === "image").length,
      documents: mediaRows.filter((r) => r.media_type === "document").length,
      groups,
    },
  };
}

// ── Renderers ─────────────────────────────────────────────────────────────────

/** Render the (already ranked/truncated) text rows grouped by chat. */
export function renderTextBlock(rows: MessageForAnalysis[]): string {
  if (rows.length === 0) return "";

  const byGroup = new Map<string, MessageForAnalysis[]>();
  for (const r of rows) {
    const g = byGroup.get(r.group_name) ?? [];
    g.push(r);
    byGroup.set(r.group_name, g);
  }

  let text = `# Mensajes de WhatsApp (${rows.length} mensajes priorizados)\n\n`;
  for (const [groupName, msgs] of byGroup) {
    text += `## ${groupName}\n`;
    // Oldest first within each group so context reads naturally.
    for (const m of [...msgs].reverse()) {
      const tag = isMainAnalystAdd(m.body) ? "[★ MAIN ANALYST ADD] " : "";
      // Senders are opaque WhatsApp ids; name the one whose word carries weight.
      const who = isMainAnalyst(m.sender) ? "MAIN ANALYST" : m.sender ?? "?";
      text += `[${formatTs(m.ts)}] ${who}: ${tag}${m.body}\n`;
    }
    text += "\n";
  }
  return text;
}

/**
 * Hard cap on a study line. The prompt asks for terseness, but a model that
 * ignores it must not be able to blow up the synthesis prompt: one over-eager
 * chart once produced a 1,500-character Fibonacci field, and the digest block
 * can carry dozens of charts.
 */
const STUDY_MAX_CHARS = 420;

function clampStudy(v: string): string {
  const t = v.replace(/\s+/g, " ").trim();
  return t.length <= STUDY_MAX_CHARS ? t : t.slice(0, STUDY_MAX_CHARS - 1) + "…";
}

const TRANSCRIPT_MAX_CHARS = 5000;
// A report is read in full (every content page), so its transcript gets room.
const PDF_TRANSCRIPT_MAX_CHARS = 30000;

function clampTranscript(v: string, max = TRANSCRIPT_MAX_CHARS): string {
  const t = v.trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

/** The digester's stub for a newspaper or magazine it discarded unread. */
function isDiscardedStub(digest: string | null): boolean {
  try {
    return /^newspaper — discarded/i.test(JSON.parse(digest ?? "").source ?? "");
  } catch {
    return false;
  }
}

function indent(v: string): string {
  return v.split("\n").map((l) => `      ${l}`).join("\n");
}

export interface MediaDigestRenderOptions {
  /**
   * Unix seconds. Verbatim transcripts are printed only for media at or after
   * this time; older files keep their summary, levels and study lines. A daily
   * run has already read the older transcripts in full, and they were 45% of a
   * 7-day bundle (200K of 446K characters on 2026-09-30).
   */
  transcriptSince?: number;
  /**
   * Digests older than `rows` whose ideas still belong in the index
   * (`loadOlderIdeaRows`). Only their ideas are printed, never their text.
   */
  olderIdeaRows?: MessageForAnalysis[];
}

/** How far back the ideas index looks, whatever the bundle's own window is. */
export const IDEAS_WINDOW_DAYS = 30;

type IndexedIdea = ReportIdea & { ts: number; old: boolean };

/**
 * Digests with ideas that are older than the bundle's window and inside the
 * ideas window: their PDFs are not in the media list, but their ideas are
 * still the houses' views.
 */
export function loadOlderIdeaRows(windowDays: number): MessageForAnalysis[] {
  if (windowDays >= IDEAS_WINDOW_DAYS) return [];
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86400;
  return getDigestsWithIdeas(IDEAS_WINDOW_DAYS).filter((r) => r.ts < cutoff);
}

function shortDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * The ideas of every report and PDF of the last IDEAS_WINDOW_DAYS, by ticker:
 * the playbook's REPORTS read. It is never clipped, unlike a transcript, so a
 * target on page 60 of a thematic note reaches the analyst.
 */
function renderIdeasIndex(ideas: IndexedIdea[], olderReports: string[]): string {
  if (ideas.length === 0) return "";
  const dash = (v?: string) => (v && v !== "—" ? v : null);
  // One symbol per company (KEPCO and 015760.KS are KEP), also for digests
  // saved before the server normalised them. A local listing (005930.KS,
  // AXIA3.SA) cannot be bought in this book: it gets a place in one compact
  // line, not a line of its own.
  const by = new Map<string, IndexedIdea[]>();
  const abroad: string[] = [];
  for (const i of normalizeIdeas(ideas)) {
    const t = i.ticker;
    if (isLocalListing(t)) {
      abroad.push(`${t} ${[dash(i.rating), dash(i.target)].filter(Boolean).join(" ")}`.trim());
    } else {
      by.set(t, [...(by.get(t) ?? []), i]);
    }
  }
  let out =
    `\n## Ideas in reports and PDFs, by ticker (${ideas.length} ideas, ${by.size} US-listed tickers, ` +
    `reports shared in the last ${IDEAS_WINDOW_DAYS} days) — the REPORTS read\n` +
    "Each line is a view a report gives on that ticker: house and the report's own date, rating, target, " +
    "thesis, page; newest first. Cite it as report evidence with its date. An older idea is still the " +
    "house's view until a newer one replaces it; it is not a signal to buy, and a target set before a " +
    "large move is stale: say so. The report is the PDF of that house and date in the list above, where " +
    "its `▤` line says how much of it was read; a line ending in `◦` comes from a report shared before " +
    "this bundle's window, listed under the index.\n";
  for (const t of [...by.keys()].sort()) {
    const lines = by
      .get(t)!
      .sort((a, b) => b.ts - a.ts)
      .map(
        (i) =>
          `${[i.house, dash(i.date)].filter(Boolean).join(" ")}` +
          `${dash(i.rating) ? ` · ${i.rating}` : ""}${dash(i.target) ? ` · target ${i.target}` : ""}` +
          ` · ${i.thesis}${dash(i.page) ? ` (p. ${i.page})` : ""}${i.old ? ` ◦ shared ${shortDate(i.ts)}` : ""}`
      );
    out += lines.length === 1 ? `- ${t}: ${lines[0]}\n` : `- ${t}\n${lines.map((l) => `    • ${l}`).join("\n")}\n`;
  }
  if (abroad.length > 0) {
    out += `- Local listings with a view (not buyable here; rating and target only): ${abroad.join("; ")}\n`;
  }
  if (olderReports.length > 0) {
    out +=
      `\nReports shared before this bundle's window whose ideas are marked \`◦\` above:\n` +
      olderReports.map((l) => `- ${l}`).join("\n") +
      "\n";
  }
  return out;
}

/** How far back the macro index looks. */
export const MACRO_WINDOW_DAYS = 30;

export function loadMacroRows(): MessageForAnalysis[] {
  return getDigestsWithMacro(MACRO_WINDOW_DAYS);
}

/**
 * The macro reads: what the reports and PDFs of the last MACRO_WINDOW_DAYS say
 * about each topic (rates, inflation, positioning, politics, the AI cycle…),
 * and beside each topic what the groups said in the bundle's own window. Macro
 * is not a trading idea and is not thrown away: it is the frame the ideas sit
 * in, and the place where a house and the main analyst can disagree.
 */
export function renderMacroReads(macroRows: MessageForAnalysis[], textRows: MessageForAnalysis[]): string {
  type Note = MacroNote & { ts: number; group: string };
  const byTopic = new Map<string, Note[]>();
  for (const r of macroRows) {
    let d: { macro?: MacroNote[] };
    try {
      d = JSON.parse(r.media_digest!);
    } catch {
      continue;
    }
    for (const n of d.macro ?? []) {
      const topic = n?.topic ? normalizeMacroTopic(n.topic) : null;
      if (!topic || !n.view) continue;
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), { ...n, topic, ts: r.ts, group: r.group_name ?? "" }]);
    }
  }
  const chat = new Map<string, MessageForAnalysis[]>();
  for (const r of textRows) {
    const body = (r.body ?? "").replace(/\s+/g, " ").trim();
    if (body.length < 25) continue;
    for (const t of macroTopicsOf(body)) chat.set(t, [...(chat.get(t) ?? []), r]);
  }
  const topics = MACRO_TOPICS.filter((t) => byTopic.has(t) || chat.has(t));
  if (byTopic.size === 0) return "";
  const stanceCount = (ns: Note[]) => {
    const c: Record<string, number> = {};
    for (const n of ns) c[n.stance] = (c[n.stance] ?? 0) + 1;
    return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(", ");
  };
  let out =
    `\n## Macro reads — reports and PDFs by topic, with what the groups said (reports of the last ${MACRO_WINDOW_DAYS} days)\n` +
    "Each topic lists the macro notes the reports and PDFs carry (house, the report's own date, stance for risk assets, " +
    "the read with its numbers, page), newest first, then the group chatter on the same topic in this bundle's window " +
    "(how many messages, and the latest from the main analyst and from others). A macro note is not a trade: use it as the " +
    "frame for the Macro reading by sector, say where houses agree or split, and where the groups and the main analyst " +
    "differ from the houses. An older note stands until a newer one replaces it.\n";
  for (const t of topics.sort((a, b) => (byTopic.get(b)?.length ?? 0) + (chat.get(b)?.length ?? 0) - (byTopic.get(a)?.length ?? 0) - (chat.get(a)?.length ?? 0))) {
    const notes = (byTopic.get(t) ?? []).sort((a, b) => b.ts - a.ts);
    out += `\n### ${t}${notes.length ? ` — ${notes.length} note(s): ${stanceCount(notes)}` : ""}\n`;
    for (const n of notes.slice(0, 8)) {
      out += `- ${n.house} ${n.date} · ${n.stance} · ${n.view}${n.page && n.page !== "—" ? ` (p. ${n.page})` : ""}\n`;
    }
    if (notes.length > 8) out += `- … and ${notes.length - 8} older note(s) on this topic\n`;
    const msgs = (chat.get(t) ?? []).sort((a, b) => b.ts - a.ts);
    if (msgs.length) {
      const main = msgs.filter((m) => isMainAnalyst(m.sender));
      out += `  Groups: ${msgs.length} message(s) in the window, ${main.length} from the main analyst.\n`;
      const shown = [...main.slice(0, 2), ...msgs.filter((m) => !isMainAnalyst(m.sender)).slice(0, 2)].sort((a, b) => b.ts - a.ts);
      for (const m of shown) {
        const body = (m.body ?? "").replace(/\s+/g, " ").trim();
        out += `    · ${formatTs(m.ts)} ${isMainAnalyst(m.sender) ? "main analyst" : "member"}: ${body.length > 230 ? body.slice(0, 229) + "…" : body}\n`;
      }
    }
  }
  return out;
}

/** Render the cached media digests (Stage 1 output) as a compact text section. */
export function renderMediaDigestBlock(
  rows: MessageForAnalysis[],
  opts: MediaDigestRenderOptions = {}
): string {
  rows = rows.filter((r) => !isDiscardedStub(r.media_digest));
  if (rows.length === 0) return "";

  let text = `## Media compartida (resúmenes — ${rows.length} archivos)\n`;
  let demarkSeen = 0;
  let fibSeen = 0;
  let transcriptsOmitted = 0;
  const ideas: IndexedIdea[] = [];
  for (const r of rows) {
    let d: {
      ticker?: string | null;
      signal?: string;
      levels?: string;
      source?: string;
      summary?: string;
      demark?: string;
      fibonacci?: string;
      transcript?: string;
      ideas?: ReportIdea[];
      pages_total?: number;
      pages_read?: string;
      full_read?: boolean;
      notes_path?: string;
    };
    try {
      d = JSON.parse(r.media_digest!);
    } catch {
      continue;
    }
    const kind = r.media_type === "document" ? "PDF" : "Imagen";
    const ticker = d.ticker ? ` ${d.ticker}` : "";
    text +=
      `- [${kind}${ticker} · ${d.signal ?? "?"}] ${formatTs(r.ts)} "${r.group_name}"` +
      `${d.levels && d.levels !== "—" ? ` · niveles: ${d.levels}` : ""}: ${d.summary ?? ""}\n`;
    // DeMark counts get their own line rather than being folded into the
    // summary — the playbook treats them as a named setup, and burying a
    // "Sell 13" inside prose is how it went unreported for months.
    // How much of a PDF was read: the analyst must not take a summary of ten
    // pages for the view of a hundred.
    if (r.media_type === "document" && (d.pages_total || d.pages_read)) {
      text +=
        `    ▤ ${d.pages_total ? `${d.pages_total} pages` : "pages"} · ` +
        `${d.full_read ? "READ IN FULL" : "NOT read in full"}${d.pages_read ? ` (${d.pages_read})` : ""}` +
        `${d.notes_path ? ` · page notes: ${d.notes_path}` : ""}\n`;
    }
    for (const i of d.ideas ?? []) {
      if (!i?.ticker) continue;
      ideas.push({ ...i, ts: r.ts, old: false });
    }
    if (d.demark && d.demark !== "—") {
      text += `    ★ DeMark: ${clampStudy(d.demark)}\n`;
      demarkSeen++;
    }
    if (d.fibonacci && d.fibonacci !== "—") {
      text += `    ◈ Fib: ${clampStudy(d.fibonacci)}\n`;
      fibSeen++;
    }
    // Verbatim text of a text-heavy image (tweet, news, broker table): the
    // summary above compresses it to a sentence, so the words themselves
    // follow, indented under their entry.
    if (d.transcript) {
      if (opts.transcriptSince != null && r.ts < opts.transcriptSince) {
        transcriptsOmitted++;
      } else {
        text += `    ✎ Texto (transcripción literal):\n${indent(
          clampTranscript(
            d.transcript,
            r.media_type === "document" ? PDF_TRANSCRIPT_MAX_CHARS : TRANSCRIPT_MAX_CHARS
          )
        )}\n`;
      }
    }
  }
  if (transcriptsOmitted > 0) {
    text +=
      `\n> ${transcriptsOmitted} older file(s) above have a verbatim transcript that is not printed ` +
      "here (summary only). Call `media_digests` with the wider window if you need the exact text.\n";
  }
  const olderReports: string[] = [];
  for (const r of opts.olderIdeaRows ?? []) {
    let d: { ideas?: ReportIdea[]; source?: string; pages_total?: number; full_read?: boolean; notes_path?: string };
    try {
      d = JSON.parse(r.media_digest!);
    } catch {
      continue;
    }
    const own = (d.ideas ?? []).filter((i) => i?.ticker);
    if (own.length === 0) continue;
    for (const i of own) ideas.push({ ...i, ts: r.ts, old: true });
    olderReports.push(
      `${(d.source ?? r.media_filename ?? "PDF").replace(/\s+/g, " ").slice(0, 110)} · shared ${shortDate(r.ts)} · ` +
        `${d.pages_total ? `${d.pages_total} pages, ` : ""}${d.full_read ? "read in full" : "NOT read in full"} · ` +
        `${own.length} idea(s)${d.notes_path ? ` · page notes: ${d.notes_path}` : ""}`
    );
  }
  text += renderIdeasIndex(ideas, olderReports);
  if (fibSeen > 0) {
    text +=
      `\n> ${fibSeen} chart(s) above carry Fibonacci levels (◈ lines). Fibonacci is the ` +
      "playbook's PRIMARY setup (\"Big Bases — Fibonacci main, Demark secondary\"). Retracements " +
      "0.236/0.382/0.5/0.618/0.786 mark where a pullback may hold; extensions 1.618/2.618/4.236 " +
      "are upside targets after a breakout. Weight the ANCHORS: levels drawn from a blow-off " +
      "spike or capitulation low are unreliable, and a chart whose pivots ignore the grid is " +
      "usually mis-anchored rather than proof Fibonacci failed. A fib level coinciding with a " +
      "DeMark 9/13, a moving average or prior structure is far stronger than one alone.\n";
  }
  if (demarkSeen > 0) {
    text +=
      `\n> ${demarkSeen} chart(s) above carry DeMark TD Sequential counts (★ lines). ` +
      "A count BELOW the bars is a Buy Setup/Countdown = BULLISH (downtrend exhausting); " +
      "ABOVE the bars is a Sell Setup/Countdown = BEARISH. 13 outranks 9. A '+' is a " +
      "deferred 13, not a 13; an 'R' voids the prior 13; counts still running past 9 mean " +
      "the trend has NOT flipped. DeMark is secondary to Big Bases/Fibonacci per the " +
      "playbook, and never overrides MM200 or an active main analyst ADD.\n";
  }
  return text + "\n";
}

// ── ADD ledger ────────────────────────────────────────────────────────

/** An ADD older than this, counted from its date on the row (the add, or the last thesis evidence the analyst re-dated it to), is aging. */
const ADD_AGING_DAYS = 90;
/** Live price this many times above/below the ledger entry = split or bad data. */
const ENTRY_SANITY_RATIO = 3;

export type AddStatus = "ACTIVE" | "AGING" | "EXPIRED" | "INVALIDATED";

export interface LedgerRow extends MainAnalystAddEntry {
  ageDays: number | null;
  price: number | null;
  slope: number | null;
  status: AddStatus;
  /** Set when the stored entry price can't be right against the live price. */
  entryWarning: string | null;
}

/** First number in a free-text entry: "~$360 (359.53 on …)" → 360. */
function parseEntry(entry: string | null): number | null {
  const m = entry?.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * The ledger with each ADD's lifecycle status, judged against live data:
 * INVALIDATED — live price below the thesis's stated invalidation level;
 * EXPIRED     — aging AND below a falling MA200 (back under the normal rules);
 * AGING       — older than 90 days, override kept but confidence capped;
 * ACTIVE      — everything else.
 * A missing quote never demotes an ADD: unknown data keeps the older status.
 */
export async function loadMainAnalystAddLedger(): Promise<LedgerRow[]> {
  const adds = listActiveMainAnalystAdds();
  if (adds.length === 0) return [];
  const tickers = adds.map((a) => a.ticker);
  const [prices, slopes] = await Promise.all([fetchCurrentPrices(tickers), fetchMa200Slopes(tickers)]);
  const now = Date.now();
  return adds.map((a) => {
    const added = a.addedOn ? Date.parse(a.addedOn + "T00:00:00Z") : NaN;
    const ageDays = Number.isNaN(added) ? null : Math.floor((now - added) / 86_400_000);
    const price = prices[a.ticker] ?? null;
    const slope = slopes[a.ticker] ?? null;
    const aging = ageDays != null && ageDays > ADD_AGING_DAYS;
    const status: AddStatus =
      a.invalidation != null && price != null && price < a.invalidation
        ? "INVALIDATED"
        : aging && slope != null && slope < 0
          ? "EXPIRED"
          : aging
            ? "AGING"
            : "ACTIVE";
    const entry = parseEntry(a.entryPrice);
    const ratio = entry && price != null ? price / entry : null;
    const entryWarning =
      ratio != null && (ratio > ENTRY_SANITY_RATIO || ratio < 1 / ENTRY_SANITY_RATIO)
        ? `⚠ entry ${entry} vs live ${price!.toFixed(2)} — split or bad data, verify`
        : null;
    return { ...a, ageDays, price, slope, status, entryWarning };
  });
}

/** Tells the reader which name in the chats and stored notes is the main analyst. */
function aliasLine(): string {
  const aliases = mainAnalystAliases();
  return aliases.length > 0
    ? `In the chats, the media digests and the notes below, the main analyst is written as: ${aliases.join(", ")}. ` +
        'Write "the main analyst" in the report.\n'
    : "";
}

/**
 * Render the persistent ADD ledger as a high-priority block. The main analyst's adds
 * don't always arrive as "+TICKER" text, so without this the synthesis loses
 * them each run and re-derives a SELL from MM200/loss rules. Each row carries
 * its lifecycle status so the override is only applied where it still holds.
 */
export function renderMainAnalystAddLedger(rows: LedgerRow[]): string {
  if (rows.length === 0) return "";
  const body = rows
    .map((r) => {
      const slope = r.slope != null ? `${r.slope >= 0 ? "↑+" : "↓"}${r.slope.toFixed(2)}%` : "—";
      const note = [r.entryWarning, r.note].filter(Boolean).join(" · ");
      return (
        `${r.ticker}|${r.status}|${r.entryPrice ?? "—"}|${r.price != null ? `$${r.price.toFixed(2)}` : "—"}|` +
        `${slope}|${r.invalidation ?? "—"}|${r.addedOn ?? "—"}|${r.ageDays != null ? `${r.ageDays}d` : "—"}|${note}`
      );
    })
    .join("\n");
  return (
    "\n## ★ ADD ledger — PERSISTED [HIGHEST PRIORITY]\n" +
    "Each row was added by the main analyst: it says WHICH name and WHY. WHEN to buy, re-buy, trim or sell is decided on the four reads of the playbook's THE AGENT DECIDES, never on a wait for his next message. Apply the ADD LIFECYCLE by the Status column:\n" +
    aliasLine() +
    "- ACTIVE: live [★ MAIN ANALYST ADD] — BUY or HOLD, never a full SELL; a concentration trim is allowed.\n" +
    "- AGING (>90d since the add or the last thesis evidence dated on the row): still blocks a full SELL, confidence capped at 70.\n" +
    "- EXPIRED (aging AND MM200 falling): no override — ordinary rules, including SELL.\n" +
    "- INVALIDATED (live below the Invalidation level): thesis broken — SELL is allowed; " +
    "if the level was stated as a weekly close, say whether the break has held on a closing basis.\n" +
    "Entry is the price AT THE ADD, not today's — quote entries from Live. A ⚠ entry flag means the " +
    "stored entry cannot be right (split or bad data): don't compute P&L from it.\n" +
    "Ticker|Status|Entry|Live|MM200|Invalidation|Added|Age|Note\n---|---|---|---|---|---|---|---|---\n" +
    body +
    "\n"
  );
}


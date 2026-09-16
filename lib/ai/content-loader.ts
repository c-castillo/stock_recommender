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
  isDrCsAdd,
  listActiveDrCsAdds,
  type MessageForAnalysis,
} from "@/lib/whatsapp/db";

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
      const tag = isDrCsAdd(m.body) ? "[★ DR CS ADD] " : "";
      text += `[${formatTs(m.ts)}] ${m.sender ?? "?"}: ${tag}${m.body}\n`;
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

/** Render the cached media digests (Stage 1 output) as a compact text section. */
export function renderMediaDigestBlock(rows: MessageForAnalysis[]): string {
  if (rows.length === 0) return "";

  let text = `## Media compartida (resúmenes — ${rows.length} archivos)\n`;
  let demarkSeen = 0;
  let fibSeen = 0;
  for (const r of rows) {
    let d: {
      ticker?: string | null;
      signal?: string;
      levels?: string;
      source?: string;
      summary?: string;
      demark?: string;
      fibonacci?: string;
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
    if (d.demark && d.demark !== "—") {
      text += `    ★ DeMark: ${clampStudy(d.demark)}\n`;
      demarkSeen++;
    }
    if (d.fibonacci && d.fibonacci !== "—") {
      text += `    ◈ Fib: ${clampStudy(d.fibonacci)}\n`;
      fibSeen++;
    }
  }
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
      "playbook, and never overrides MM200 or an active Dr CS ADD.\n";
  }
  return text + "\n";
}

/**
 * Render the persistent Dr CS ADD ledger as a high-priority block. Dr CS's adds
 * don't always arrive as "+TICKER" text, so without this the synthesis loses
 * them each run and re-derives a SELL from MM200/loss rules. These rows carry
 * the SYSTEM_PROMPT's [★ DR CS ADD] override until explicitly deactivated.
 */
export function renderDrCsAddLedger(): string {
  const adds = listActiveDrCsAdds();
  if (adds.length === 0) return "";
  const today = Date.now();
  const rows = adds
    .map((a) => {
      const added = a.addedOn ? Date.parse(a.addedOn + "T00:00:00Z") : NaN;
      const age = Number.isNaN(added)
        ? "—"
        : `${Math.floor((today - added) / 86_400_000)}d`;
      return `${a.ticker}|${a.entryPrice ?? "—"}|${a.addedOn ?? "—"}|${age}|${a.note ?? ""}`;
    })
    .join("\n");
  return (
    "\n## ★ Active Dr CS ADDs — PERSISTED LEDGER [HIGHEST PRIORITY]\n" +
    "Each ticker below was added by Dr CS and REMAINS ACTIVE until Dr CS issues a SELL. " +
    "Treat every row as a live [★ DR CS ADD]: strongest bullish signal, action BUY or HOLD (NEVER SELL), confidence ≥85 — " +
    "UNLESS this session's content contains an explicit Dr CS SELL/exit for that specific ticker. " +
    "A negative MM200, an unrealized loss, or a factor/basket unwind does NOT override an active ADD.\n" +
    "Age is how long the ADD has gone without a refresh from Dr CS. An ADD over 90 days old still " +
    "blocks a SELL, but do not assert \u226585 confidence on it — call it aging and lower confidence. " +
    "Entry levels here are the price AT THE ADD, not today's: quote entries from the live price block.\n" +
    "Ticker|Entry|Added|Age|Note\n---|---|---|---|---\n" +
    rows +
    "\n"
  );
}


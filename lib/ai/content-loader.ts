/**
 * Loads downloaded WhatsApp content for analysis.
 *
 * Media is NOT sent as raw base64 anymore — chart images and PDFs are digested
 * once at ingestion (see media-digest.ts) and surfaced here as compact text.
 * This module exposes the filtered rows so the caller can rank/truncate before
 * rendering, then provides the render helpers.
 */

import { getContentForAnalysis, isDrCsAdd, type MessageForAnalysis } from "@/lib/whatsapp/db";

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

export function loadAnalysisInputs(): AnalysisInputs {
  const rows = getContentForAnalysis(7, MAX_TEXT_MESSAGES);

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

  let text = `# Mensajes de WhatsApp — últimos 7 días (${rows.length} mensajes priorizados)\n\n`;
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

/** Render the cached media digests (Stage 1 output) as a compact text section. */
export function renderMediaDigestBlock(rows: MessageForAnalysis[]): string {
  if (rows.length === 0) return "";

  let text = `## Media compartida (resúmenes — ${rows.length} archivos)\n`;
  for (const r of rows) {
    let d: {
      ticker?: string | null;
      signal?: string;
      levels?: string;
      source?: string;
      summary?: string;
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
  }
  return text + "\n";
}

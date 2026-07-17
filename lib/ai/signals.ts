/**
 * Stage 2 — cheap signal extraction + message ranking (model tiering: Haiku).
 *
 * A single Haiku pass condenses the relevant text corpus into a per-ticker
 * sentiment/conviction rollup. That rollup (a) is injected into the synthesis
 * prompt as pre-digested context, and (b) drives rank-and-truncate of the raw
 * messages so the flagship synthesis call only sees the highest-signal subset
 * instead of all ~3,500 messages.
 *
 * Fully fail-safe: if the Haiku pass throws, the rollup is empty and ranking
 * falls back to a Dr-CS-first keyword-density heuristic.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { isDrCsAdd, type MessageForAnalysis } from "@/lib/whatsapp/db";

/** Messages fed into the Haiku signal pass (most recent first). */
const SIGNAL_MSG_CAP = 1200;
/** Max raw messages the synthesis call receives after ranking. */
export const SYNTHESIS_MSG_LIMIT = 1500;

const rollupSchema = z.object({
  tickers: z
    .array(
      z.object({
        ticker: z.string().describe("US-equity ticker symbol, uppercase"),
        sentiment: z.enum(["bullish", "bearish", "neutral"]),
        conviction: z
          .number()
          .describe(
            "0-100. Higher = stronger/credible/repeated case (technical, fundamental, Dr CS adds rank highest)"
          ),
        note: z.string().describe("One terse line on what was said and by whom"),
      })
    )
    .describe("One entry per ticker meaningfully discussed in the corpus"),
});

export type SignalRollup = z.infer<typeof rollupSchema>;

const TICKER_RE = /\b[A-Z]{1,5}\b/g;
const KEYWORD_RE =
  /\$[0-9]|%|precio|target|stop|soporte|resistencia|comprar?|vender?|long|short|bull|bear|fibonacci|earnings|reporte|chart|grafico/i;

/** Stage 2 pass: condense the corpus into a per-ticker rollup via Haiku. */
export async function summarizeSignals(
  textRows: MessageForAnalysis[]
): Promise<SignalRollup> {
  const rows = textRows.slice(0, SIGNAL_MSG_CAP);
  if (rows.length === 0) return { tickers: [] };

  const corpus = rows
    .map((r) => `${r.sender ?? "?"}: ${r.body ?? ""}`)
    .join("\n")
    .slice(0, 60_000);

  try {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: rollupSchema,
      maxOutputTokens: 4096,
      messages: [
        {
          role: "user",
          content:
            "From these stock-trading WhatsApp messages, extract a per-ticker " +
            "sentiment and conviction rollup. Treat '+TICKER' (Dr CS watchlist " +
            "adds) as the strongest bullish signal. Ignore greetings/off-topic " +
            "chatter.\n\n" +
            corpus,
        },
      ],
    });
    return object;
  } catch {
    return { tickers: [] };
  }
}

/**
 * #5 — rank raw messages by stage-2 conviction + keyword density, keeping Dr CS
 * adds verbatim, and truncate to `limit`. Preserves original ordering of the
 * kept subset so the rendered transcript still reads chronologically.
 */
export function rankAndTruncate(
  textRows: MessageForAnalysis[],
  rollup: SignalRollup,
  limit = SYNTHESIS_MSG_LIMIT
): MessageForAnalysis[] {
  if (textRows.length <= limit) return textRows;

  const convictionByTicker = new Map<string, number>();
  for (const t of rollup.tickers) {
    convictionByTicker.set(t.ticker.toUpperCase(), t.conviction);
  }

  const score = (r: MessageForAnalysis): number => {
    const body = r.body ?? "";
    if (isDrCsAdd(body)) return 10_000; // always keep Dr CS adds
    let s = 0;
    const seen = new Set<string>();
    for (const m of body.match(TICKER_RE) ?? []) {
      if (seen.has(m)) continue;
      seen.add(m);
      s += convictionByTicker.get(m) ?? 0;
    }
    if (KEYWORD_RE.test(body)) s += 15;
    s += Math.min(body.length / 50, 10); // mild length bonus, capped
    return s;
  };

  // Pick the top `limit` by score, then restore original order.
  const indexed = textRows.map((row, idx) => ({ row, idx, s: score(row) }));
  indexed.sort((a, b) => b.s - a.s || a.idx - b.idx);
  const kept = indexed.slice(0, limit);
  kept.sort((a, b) => a.idx - b.idx);
  return kept.map((k) => k.row);
}

/** Render the stage-2 rollup as a compact table for the synthesis prompt. */
export function renderSignalRollup(rollup: SignalRollup): string {
  if (rollup.tickers.length === 0) return "";
  const sorted = [...rollup.tickers].sort((a, b) => b.conviction - a.conviction);
  return (
    "\n## Signal rollup (Stage-2 pre-pass)\nTicker|Sentiment|Conviction|Note\n---|---|---|---\n" +
    sorted
      .map((t) => `${t.ticker}|${t.sentiment}|${t.conviction}|${t.note}`)
      .join("\n") +
    "\n"
  );
}

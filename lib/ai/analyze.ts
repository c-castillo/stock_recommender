/**
 * Streams an investment analysis from a staged, cost-tiered pipeline:
 *
 *   Stage 1 (Haiku)  media-digest.ts   — chart/PDF → cached text digest (once)
 *   Stage 2 (Haiku)  signals.ts        — per-ticker rollup + message ranking
 *   Stage 3 (Sonnet) here              — narrative synthesis (streamed)
 *   Extract (Haiku)  extract-recs      — structured recommendation array
 *
 * The Sonnet call's stable prefix is the frozen playbook alone, sent as a cached
 * system message. Everything else — the ADD ledger, SEC filings, ranked messages,
 * media digests, portfolio, prior wiki verdicts, memory — goes in the user turn
 * after the breakpoint. Prior verdicts in particular MUST stay out of the system
 * prompt: there they read as rules rather than as the model's own past output.
 */

import { createHash } from "crypto";
import { anthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import {
  listPortfolio,
  getAnalysisCache,
  setAnalysisCache,
  listActiveDrCsAdds,
  countSelectedGroups,
  type PortfolioPosition,
} from "@/lib/whatsapp/db";
import type { MessageForAnalysis } from "@/lib/whatsapp/db";
import { SYSTEM_PROMPT } from "./playbook";
import { buildPortfolioContext } from "./portfolio-context";
import { loadAllWikis, updateWikiEntry } from "./wiki";
import {
  loadAnalysisInputs,
  renderTextBlock,
  renderMediaDigestBlock,
  renderDrCsAddLedger,
  type AnalysisStats,
} from "./content-loader";
import { ensureMediaDigests } from "./media-digest";
import { sweepRelevance } from "./relevance";
import {
  summarizeSignals,
  rankAndTruncate,
  renderSignalRollup,
} from "./signals";
import { recommendationsFromNarrative } from "./extract-recommendations";
import { fetchRecentFilings, renderFilingsBlock } from "@/lib/market/filings";
import { preAnalysisMemoryCheck, postAnalysisMemoryUpdate } from "./memory-agent";

export type { AnalysisStats };

// ── Result cache ──────────────────────────────────────────────────────────────

/**
 * How long a cached analysis stays valid. A re-run within this window whose
 * message/media/portfolio inputs are unchanged replays the cached report and
 * makes ZERO Claude calls. Kept short so live BUY entry prices in a replayed
 * report don't drift far from the market (see dynamic-pricing requirement).
 */
const ANALYSIS_CACHE_TTL_MS = 90 * 60 * 1000; // 90 minutes

/** Look-back for the SEC filings block — wide enough to catch a quarter's print. */
const FILINGS_WINDOW_DAYS = 45;

/**
 * Fingerprints the inputs that actually determine the report: the set of
 * messages, their media digests, and current portfolio holdings. Live prices
 * are intentionally excluded — they change every run, so the short TTL (not the
 * hash) bounds their staleness.
 */
function analysisInputsHash(
  textRows: MessageForAnalysis[],
  mediaRows: MessageForAnalysis[],
  positions: PortfolioPosition[]
): string {
  const h = createHash("sha256");
  for (const r of textRows) h.update(r.id + "\n");
  h.update("|media|");
  for (const r of mediaRows) h.update(r.id + ":" + (r.media_digest ?? "") + "\n");
  h.update("|portfolio|");
  for (const p of positions) h.update(`${p.ticker}:${p.shares}:${p.avg_cost ?? ""}\n`);
  // Fold the active ADD ledger in so recording/deactivating an ADD busts the
  // cache and forces a fresh report instead of replaying a stale one.
  h.update("|dradds|");
  for (const a of listActiveDrCsAdds()) h.update(`${a.ticker}:${a.entryPrice ?? ""}\n`);
  // The rules themselves are an input: editing the playbook must produce a new
  // report, not a replay of one written under the old contract.
  h.update("|playbook|" + SYSTEM_PROMPT);
  return h.digest("hex");
}

// ── Streaming generator ───────────────────────────────────────────────────────

interface AnalysisChunk {
  type: "stats" | "text" | "recommendations" | "done" | "error";
  content?: string;
  stats?: AnalysisStats;
  recommendations?: AIRecommendation[];
  error?: string;
}

export async function* streamAnalysis(): AsyncGenerator<AnalysisChunk> {
  // Stage 0b: mark off-topic chatter in the mixed groups so it never reaches
  // synthesis. Marks only — nothing is deleted — and failures leave messages
  // unclassified, which reads as relevant.
  await sweepRelevance();

  // Stage 1: ensure every chart/PDF in the window has a cached digest.
  // Idempotent — usually a no-op when digesting already happened at ingestion.
  await ensureMediaDigests(7);

  const { textRows, mediaRows, stats } = loadAnalysisInputs();

  if (stats.textMessages === 0 && stats.images === 0 && stats.documents === 0) {
    // Distinguish "nothing downloaded" from "nothing selected" — they look
    // identical from here but need opposite fixes, and pointing at the sync
    // when the real cause is an empty selection sends you in circles.
    yield {
      type: "error",
      error:
        countSelectedGroups() === 0
          ? "Ningún grupo está seleccionado para análisis. Elige al menos uno en el dashboard " +
            "(los grupos nuevos llegan sin seleccionar a propósito)."
          : "No hay contenido para analizar. Descarga el historial de al menos un grupo primero.",
    };
    return;
  }

  yield { type: "stats", stats };

  // Result cache: if the underlying content + portfolio are unchanged and the
  // last report is still fresh, replay it instead of re-running the pipeline.
  const positions = listPortfolio();
  const inputsHash = analysisInputsHash(textRows, mediaRows, positions);
  const cached = getAnalysisCache();
  if (
    cached &&
    cached.hash === inputsHash &&
    Date.now() - cached.createdAt < ANALYSIS_CACHE_TTL_MS
  ) {
    if (cached.narrative) yield { type: "text", content: cached.narrative };
    yield {
      type: "recommendations",
      recommendations: cached.recommendations as AIRecommendation[],
    };
    yield { type: "done" };
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  // Company events the corpus cannot see. Bounded to what we actually hold or
  // track, so this stays one cheap fan-out.
  const eventTickers = [
    ...positions.map((p) => p.ticker),
    ...listActiveDrCsAdds().map((a) => a.ticker),
  ];

  // Run memory check, portfolio context, Stage-2 rollup and filings in parallel.
  const [memoryContext, portfolioContext, rollup, filings] = await Promise.all([
    preAnalysisMemoryCheck(),
    buildPortfolioContext(),
    summarizeSignals(textRows),
    fetchRecentFilings(eventTickers, FILINGS_WINDOW_DAYS),
  ]);

  // #5 — rank raw messages by Stage-2 conviction, keep Dr CS verbatim, truncate.
  const ranked = rankAndTruncate(textRows, rollup);

  // Stable, cacheable prefix: the frozen playbook ONLY.
  //
  // Prior wiki verdicts used to live here too. Sitting in the system prompt
  // beside the rules, they read as standing instructions rather than as the
  // model's own past output, and got cited as evidence for themselves. They now
  // move into the user turn behind an explicit "NOT EVIDENCE" header. This
  // costs no cache: every run appends a wiki entry, so the prefix busted daily.
  const stablePrefix = SYSTEM_PROMPT;

  // Volatile user turn (after the cache breakpoint). The persisted ADD ledger
  // goes first so it's the most prominent signal in the turn; prior verdicts go
  // last, after all the real evidence.
  const userContent =
    renderDrCsAddLedger() +
    renderFilingsBlock(filings, FILINGS_WINDOW_DAYS) +
    renderSignalRollup(rollup) +
    renderTextBlock(ranked) +
    renderMediaDigestBlock(mediaRows) +
    portfolioContext +
    loadAllWikis() +
    memoryContext +
    "\n---\n" +
    `Analiza todo el contenido anterior (${ranked.length} mensajes priorizados, ${stats.images} imágenes, ${stats.documents} documentos PDF de ${stats.groups.length} grupo(s) — últimos 7 días) ` +
    "y genera el informe de inversión completo en Markdown.";

  // Stage 3: synthesis on Sonnet. Stable prefix cached; volatile turn after it.
  const result = streamText({
    model: anthropic("claude-sonnet-4-6"),
    maxOutputTokens: 32000,
    system: [
      {
        role: "system",
        content: stablePrefix,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      },
    ],
    messages: [{ role: "user", content: userContent }],
  });

  let fullText = "";
  for await (const chunk of result.textStream) {
    fullText += chunk;
    yield { type: "text", content: chunk };
  }

  // #3 — structured recommendations via a cheap Haiku extraction pass.
  const recommendations = await recommendationsFromNarrative(fullText);
  yield { type: "recommendations", recommendations };

  // Cache the finished report so an unchanged re-run within the TTL replays it
  // with zero Claude calls.
  setAnalysisCache({
    hash: inputsHash,
    createdAt: Date.now(),
    narrative: fullText,
    recommendations,
    stats,
  });

  // Persist per-ticker wiki history from the structured recs.
  for (const rec of recommendations) {
    try {
      updateWikiEntry(rec, today);
    } catch {
      // Non-fatal
    }
  }

  // Update cross-session memory (non-blocking).
  if (recommendations.length > 0) {
    postAnalysisMemoryUpdate(JSON.stringify(recommendations), today).catch(() => {});
  }

  yield { type: "done" };
}

// ── Recommendation type ───────────────────────────────────────────────────────

export interface AIRecommendation {
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
  generatedAt?: number;
}

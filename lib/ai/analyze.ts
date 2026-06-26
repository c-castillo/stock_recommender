/**
 * Streams an investment analysis from a staged, cost-tiered pipeline:
 *
 *   Stage 1 (Haiku)  media-digest.ts   — chart/PDF → cached text digest (once)
 *   Stage 2 (Haiku)  signals.ts        — per-ticker rollup + message ranking
 *   Stage 3 (Sonnet) here              — narrative synthesis (streamed)
 *   Extract (Haiku)  extract-recs      — structured recommendation array
 *
 * The Sonnet call's stable prefix (frozen system prompt + wiki history) is sent
 * as a cached system message; volatile context (portfolio, live prices, memory,
 * ranked messages, media digests) goes in the user turn, after the breakpoint.
 */

import { createHash } from "crypto";
import { anthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import {
  listPortfolio,
  getCashBalance,
  getAnalysisCache,
  setAnalysisCache,
  type PortfolioPosition,
} from "@/lib/whatsapp/db";
import type { MessageForAnalysis } from "@/lib/whatsapp/db";
import { fetchMa200Slopes } from "@/lib/ma200";
import { loadAllWikis, updateWikiEntry } from "./wiki";
import {
  loadAnalysisInputs,
  renderTextBlock,
  renderMediaDigestBlock,
  type AnalysisStats,
} from "./content-loader";
import { ensureMediaDigests } from "./media-digest";
import {
  summarizeSignals,
  rankAndTruncate,
  renderSignalRollup,
} from "./signals";
import { recommendationsFromNarrative } from "./extract-recommendations";
import { preAnalysisMemoryCheck, postAnalysisMemoryUpdate } from "./memory-agent";

export type { AnalysisStats };

// ── Current price fetcher ─────────────────────────────────────────────────────

async function fetchCurrentPrices(
  tickers: string[]
): Promise<Record<string, number | null>> {
  const prices: Record<string, number | null> = {};
  for (const t of tickers) prices[t] = null;
  if (tickers.length === 0) return prices;

  // Yahoo's v7 /quote endpoint now requires a crumb+cookie and returns 401
  // Unauthorized. The v8 /chart endpoint is still anonymous-accessible and
  // exposes the live price at result[0].meta.regularMarketPrice. It's one
  // request per symbol, so fan out in parallel.
  await Promise.all(
    tickers.map(async (t) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;
        const data = await res.json();
        const meta = data?.chart?.result?.[0]?.meta;
        const price = meta?.regularMarketPrice;
        if (typeof price === "number") {
          prices[(meta.symbol ?? t).toUpperCase()] = price;
        }
      } catch {
        /* leave this ticker null on per-symbol failure */
      }
    })
  );

  return prices;
}

// ── Stable system prompt (frozen → cacheable prefix) ──────────────────────────

const SYSTEM_PROMPT = `Expert financial analyst. US equities only (no options; inverse ETFs for shorts). Broker: Zesty.

PHILOSOPHY: Trend follower (Gartman #19). Strong banks=stable markets. MM200/12mMA slope ↑→long bias, ↓→avoid/short. NH>NL=healthy→aggressive longs; opposite→shorts. Primary setup: Big Bases (Fibonacci main, Demark secondary).

METHODOLOGY: Extract all tickers (text + media digests). Sentiment per mention: bullish/bearish/neutral ("skeletor"=bearish; watch irony/sarcasm). Credibility: technical/fundamental>opinions>rumors; prioritize Dr CS & PDF reports. Note consensus vs isolated views. A Stage-2 signal rollup and per-file media digests are provided as pre-analysis — weigh them but verify against the raw messages.

★ DR CS ADD [HIGHEST PRIORITY]: [★ DR CS ADD] tags = Dr CS added ticker to watchlist (+TICKER). Strongest bullish signal; overrides all others. Confidence≥85 unless session content explicitly contradicts. Sort to top if multiple.

OUTPUT (Markdown report — do NOT emit a JSON block; structured data is extracted separately):
📊 Market summary
🔍 Per-ticker: what was said, sentiment, argument strength, sources
💡 Recommendations: for each, state action (BUY|SELL|HOLD), confidence 0-100, entry price, price target, stop loss, and rationale in prose.`;

// ── Volatile portfolio context (after the cache breakpoint) ───────────────────

async function buildPortfolioContext(): Promise<string> {
  const positions = listPortfolio();
  const cash = getCashBalance();
  const portfolioTickers = positions.map((p) => p.ticker);

  const [slopes, currentPrices] = await Promise.all([
    positions.length > 0
      ? fetchMa200Slopes(portfolioTickers)
      : Promise.resolve({} as Record<string, number | null>),
    portfolioTickers.length > 0
      ? fetchCurrentPrices(portfolioTickers)
      : Promise.resolve({} as Record<string, number | null>),
  ]);

  let section = "\n## Portfolio\n";

  if (cash !== null) {
    section += `Cash: $${cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
  }

  if (positions.length > 0) {
    section += "\nTicker|Shares|AvgCost|Price|MktVal|P&L|MM200\n";
    section += "---|---|---|---|---|---|---\n";
    for (const p of positions) {
      const avgCost = p.avg_cost != null ? `$${p.avg_cost.toFixed(2)}` : "—";
      const price = p.current_price != null ? `$${p.current_price.toFixed(2)}` : "—";
      const mv = p.market_value != null ? `$${p.market_value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—";
      const pl = p.unrealized_pl != null
        ? `$${p.unrealized_pl.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}(${p.unrealized_pl_pc != null ? p.unrealized_pl_pc.toFixed(1) + "%" : "—"})`
        : "—";
      const slope = slopes[p.ticker];
      const slopeStr = slope != null ? `${slope >= 0 ? "↑+" : "↓"}${slope.toFixed(2)}%` : "—";
      section += `${p.ticker}|${p.shares}|${avgCost}|${price}|${mv}|${pl}|${slopeStr}\n`;
    }
  } else {
    section += "No positions.\n";
  }

  section += `\nRules: MM200↑=long, MM200↓=avoid. Existing: add/hold/exit. New buy: check cash. Size 5-20%. Stop: existing+profit→trailing% (e.g."15%"), new→price level (e.g."$810").\n`;

  // Live prices for portfolio tickers — used as entryPrice for BUYs.
  const priceEntries = Object.entries(currentPrices).filter(([, v]) => v !== null) as [string, number][];
  if (priceEntries.length > 0) {
    priceEntries.sort(([a], [b]) => a.localeCompare(b));
    section +=
      "\n## Live prices (Yahoo Finance) — use as entryPrice for BUY:\nTicker|Price\n---|---\n" +
      priceEntries.map(([t, p]) => `${t}|$${p.toFixed(2)}`).join("\n") +
      "\n";
  }

  return section;
}

// ── Result cache ──────────────────────────────────────────────────────────────

/**
 * How long a cached analysis stays valid. A re-run within this window whose
 * message/media/portfolio inputs are unchanged replays the cached report and
 * makes ZERO Claude calls. Kept short so live BUY entry prices in a replayed
 * report don't drift far from the market (see dynamic-pricing requirement).
 */
const ANALYSIS_CACHE_TTL_MS = 90 * 60 * 1000; // 90 minutes

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
  // Stage 1: ensure every chart/PDF in the window has a cached digest.
  // Idempotent — usually a no-op when digesting already happened at ingestion.
  await ensureMediaDigests(7);

  const { textRows, mediaRows, stats } = loadAnalysisInputs();

  if (stats.textMessages === 0 && stats.images === 0 && stats.documents === 0) {
    yield {
      type: "error",
      error:
        "No hay contenido para analizar. Descarga el historial de al menos un grupo primero.",
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

  // Run memory check, portfolio context, and Stage-2 signal rollup in parallel.
  const [memoryContext, portfolioContext, rollup] = await Promise.all([
    preAnalysisMemoryCheck(),
    buildPortfolioContext(),
    summarizeSignals(textRows),
  ]);

  // #5 — rank raw messages by Stage-2 conviction, keep Dr CS verbatim, truncate.
  const ranked = rankAndTruncate(textRows, rollup);

  // Stable, cacheable prefix: frozen prompt + accumulated wiki history.
  const stablePrefix = SYSTEM_PROMPT + "\n" + loadAllWikis();

  // Volatile user turn (after the cache breakpoint).
  const userContent =
    renderSignalRollup(rollup) +
    renderTextBlock(ranked) +
    renderMediaDigestBlock(mediaRows) +
    portfolioContext +
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

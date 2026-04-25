/**
 * Sends all downloaded WhatsApp content to Claude Opus 4.6
 * and streams back an investment analysis with structured recommendations.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import fs from "fs";
import path from "path";
import { loadContent } from "./content-loader";
import { listPortfolio, getCashBalance } from "@/lib/whatsapp/db";
import { fetchMa200Slopes } from "@/lib/ma200";
import { loadAllWikis, updateWikiEntry } from "./wiki";
import { extractRecommendations } from "./extract-recommendations";


// ── Current price fetcher ─────────────────────────────────────────────────────

async function fetchCurrentPrices(
  tickers: string[]
): Promise<Record<string, number | null>> {
  const prices: Record<string, number | null> = {};
  for (const t of tickers) prices[t] = null;
  if (tickers.length === 0) return prices;

  try {
    const symbols = tickers.join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const results: any[] = data?.quoteResponse?.result ?? [];
      for (const q of results) {
        const sym = (q.symbol as string)?.toUpperCase();
        if (sym && typeof q.regularMarketPrice === "number") {
          prices[sym] = q.regularMarketPrice;
        }
      }
    }
  } catch {
    /* return nulls on network failure */
  }

  return prices;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Expert financial analyst. US equities only (no options; inverse ETFs for shorts). Broker: Zesty.

PHILOSOPHY: Trend follower (Gartman #19). Strong banks=stable markets. MM200/12mMA slope ↑→long bias, ↓→avoid/short. NH>NL=healthy→aggressive longs; opposite→shorts. Primary setup: Big Bases (Fibonacci main, Demark secondary).

METHODOLOGY: Extract all tickers (text/images/PDFs). Sentiment per mention: bullish/bearish/neutral ("skeletor"=bearish; watch irony/sarcasm). Credibility: technical/fundamental>opinions>rumors; prioritize Dr CS & PDF reports. Note consensus vs isolated views.

★ DR CS ADD [HIGHEST PRIORITY]: [★ DR CS ADD] tags = Dr CS added ticker to watchlist (+TICKER). Strongest bullish signal; overrides all others. Confidence≥85 unless session content explicitly contradicts. Always include in JSON; sort to top if multiple.

OUTPUT:
📊 Market summary
🔍 Per-ticker: what was said, sentiment, argument strength, sources
💡 Recommendations (narrative+rationale)
📋 End with this JSON (action=BUY|SELL|HOLD, confidence=0-100, null if unknown):
\`\`\`json
[{"ticker":"NVDA","company":"NVIDIA Corporation","action":"BUY","confidence":88,"entryPrice":"$850","priceTarget":"$1050","stopLoss":"$810","reasoning":"...","mentions":9,"sources":["..."]}]
\`\`\`
`;

// ── Portfolio context injector ────────────────────────────────────────────────

async function buildSystemPrompt(): Promise<string> {
  const positions = listPortfolio();
  const cash = getCashBalance();

  // Collect all tickers: portfolio + wiki files
  const wikiDir = path.join(process.cwd(), "wiki");
  const wikiTickers = fs.existsSync(wikiDir)
    ? fs.readdirSync(wikiDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, "").toUpperCase())
    : [];
  const portfolioTickers = positions.map((p) => p.ticker);
  const allTickers = [...new Set([...portfolioTickers, ...wikiTickers])];

  // Fetch MM200 slopes and current prices in parallel
  const [slopes, currentPrices] = await Promise.all([
    positions.length > 0 ? fetchMa200Slopes(portfolioTickers) : Promise.resolve({} as Record<string, number | null>),
    fetchCurrentPrices(allTickers),
  ]);

  let portfolioSection = "\n## Portfolio\n";

  if (cash !== null) {
    portfolioSection += `Cash: $${cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
  }

  if (positions.length > 0) {
    portfolioSection += "\nTicker|Shares|AvgCost|Price|MktVal|P&L|MM200\n";
    portfolioSection += "---|---|---|---|---|---|---\n";
    for (const p of positions) {
      const avgCost = p.avg_cost != null ? `$${p.avg_cost.toFixed(2)}` : "—";
      const price = p.current_price != null ? `$${p.current_price.toFixed(2)}` : "—";
      const mv = p.market_value != null ? `$${p.market_value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—";
      const pl = p.unrealized_pl != null
        ? `$${p.unrealized_pl.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}(${p.unrealized_pl_pc != null ? p.unrealized_pl_pc.toFixed(1) + "%" : "—"})`
        : "—";
      const slope = slopes[p.ticker];
      const slopeStr = slope != null ? `${slope >= 0 ? "↑+" : "↓"}${slope.toFixed(2)}%` : "—";
      portfolioSection += `${p.ticker}|${p.shares}|${avgCost}|${price}|${mv}|${pl}|${slopeStr}\n`;
    }
  } else {
    portfolioSection += "No positions.\n";
  }

  portfolioSection += `\nRules: MM200↑=long, MM200↓=avoid. Existing: add/hold/exit. New buy: check cash. Size 5-20%. Stop: existing+profit→trailing% (e.g."15%"), new→price level (e.g."$810").\n`;

  // Build current prices section
  const priceEntries = Object.entries(currentPrices).filter(([, v]) => v !== null) as [string, number][];
  let pricesSection = "";
  if (priceEntries.length > 0) {
    priceEntries.sort(([a], [b]) => a.localeCompare(b));
    pricesSection =
      "\n## Live prices (Yahoo Finance) — use as entryPrice for BUY:\nTicker|Price\n---|---\n" +
      priceEntries.map(([t, p]) => `${t}|$${p.toFixed(2)}`).join("\n") +
      "\n";
  }

  const wikiSection = loadAllWikis();

  return SYSTEM_PROMPT + portfolioSection + pricesSection + (wikiSection ? `\n${wikiSection}` : "");
}

// ── Streaming generator ───────────────────────────────────────────────────────

export interface AnalysisStats {
  textMessages: number;
  images: number;
  documents: number;
  groups: string[];
}

interface AnalysisChunk {
  type: "stats" | "text" | "done" | "error";
  content?: string;
  stats?: AnalysisStats;
  error?: string;
}

export async function* streamAnalysis(): AsyncGenerator<AnalysisChunk> {
  // Load all downloaded content
  const { blocks, stats } = loadContent();

  if (stats.textMessages === 0 && stats.images === 0 && stats.documents === 0) {
    yield {
      type: "error",
      error:
        "No hay contenido para analizar. Descarga el historial de al menos un grupo primero.",
    };
    return;
  }

  // Emit stats so the UI can show what's being analyzed
  yield { type: "stats", stats };

  // Build the user message
  const userContent = [
    ...blocks,
    {
      type: "text" as const,
      text:
        "\n---\n" +
        `Analiza todo el contenido anterior (${stats.textMessages} mensajes, ${stats.images} imágenes, ${stats.documents} documentos PDF de ${stats.groups.length} grupo(s) — últimos 7 días desde la base de datos) ` +
        "y genera el informe de inversión completo con el JSON estructurado al final.",
    },
  ];

  // Stream from Claude Sonnet 4.5
  const result = streamText({
    model: anthropic("claude-sonnet-4-5"),
    maxOutputTokens: 16000,
    system: await buildSystemPrompt(),
    messages: [{ role: "user", content: userContent }],
  });

  let fullText = "";
  for await (const chunk of result.textStream) {
    fullText += chunk;
    yield { type: "text", content: chunk };
  }

  // Persist new entries to each ticker's wiki file
  const today = new Date().toISOString().slice(0, 10);
  const recommendations = extractRecommendations(fullText);
  for (const rec of recommendations) {
    try {
      updateWikiEntry(rec, today);
    } catch {
      // Non-fatal: wiki write failure should not break the response
    }
  }

  yield { type: "done" };
}

// ── Recommendation extractor ──────────────────────────────────────────────────

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


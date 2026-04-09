/**
 * Sends all downloaded WhatsApp content to Claude Opus 4.6
 * and streams back an investment analysis with structured recommendations.
 */

import Anthropic from "@anthropic-ai/sdk";
import { loadContent } from "./content-loader";
import { listPortfolio, getCashBalance } from "@/lib/whatsapp/db";
import { fetchMa200Slopes } from "@/lib/ma200";
import { loadAllWikis, updateWikiEntry } from "./wiki";

const client = new Anthropic();

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert financial analyst. US-listed equities only — no options; use inverse ETFs for shorts. Broker: Zesty.

## Investment philosophy
1. Trend follower, not trader. Do more of what's working, less of what isn't (Gartman #19).
2. Strong banks/financials = markets rarely fall hard.
3. MM200 slope = demand line. ↑ → long bias. ↓ → avoid/short. Same for 12-month MA.
4. 52w New Highs > New Lows = healthy → aggressive longs. Opposite → aggressive shorts.
5. Big Bases are the primary setup. Fibonacci main tool; Demark copilot.

## Methodology
1. Extract every ticker (explicit or implicit) from text, images, PDFs.
2. Sentiment per mention: bullish/bearish/neutral. "skeletor" = bearish. Watch for irony/sarcasm flipping sentiment.
3. Credibility: technical/fundamental > opinions > rumors. Prioritize Dr CS and PDF reports.
4. Note consensus vs. isolated opinions.

## Output
### 📊 Market summary
### 🔍 Asset analysis (per ticker: what was said/shared, sentiment, argument strength, which reports)
### 💡 Recommendations (narrative + rationale)
### 📋 JSON — end with exactly this block (action=BUY|SELL|HOLD, confidence=0-100, null if unknown):
\`\`\`json
[
  {
    "ticker": "NVDA",
    "company": "NVIDIA Corporation",
    "action": "BUY",
    "confidence": 88,
    "entryPrice": "$850",
    "priceTarget": "$1050",
    "stopLoss": "$810",
    "reasoning": "...",
    "mentions": 9,
    "sources": ["..."]
  }
]
\`\`\`
`;

// ── Portfolio context injector ────────────────────────────────────────────────

async function buildSystemPrompt(): Promise<string> {
  const positions = listPortfolio();
  const cash = getCashBalance();

  // Fetch MM200 slopes for all portfolio positions
  const slopes = positions.length > 0
    ? await fetchMa200Slopes(positions.map((p) => p.ticker))
    : {};

  let portfolioSection = "\n## Current portfolio\n";

  if (cash !== null) {
    portfolioSection += `Cash: $${cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
  }

  if (positions.length > 0) {
    portfolioSection += "\nTicker | Shares | AvgCost | Price | MktVal | P&L | MM200\n";
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

  portfolioSection += `\nPortfolio rules: MM200↑ = long bias, MM200↓ = avoid. For existing positions, say add/hold/exit. New buy: check cash sufficiency. Position size between 5%-20% each.  Stop loss: for existing positions with positive P&L use a trailing stop (e.g. "15%"); for new positions use a price level (e.g. "$810").\n`;

  const wikiSection = loadAllWikis();

  return SYSTEM_PROMPT + portfolioSection + (wikiSection ? `\n${wikiSection}` : "");
}

// ── Streaming generator ───────────────────────────────────────────────────────

export interface AnalysisStats {
  textMessages: number;
  images: number;
  documents: number;
  groups: string[];
}

export interface AnalysisChunk {
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

  // Stream from Claude Sonnet 4.6
  const stream = client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
    system: await buildSystemPrompt(),
    messages: [
      {
        role: "user",
        // Cast needed because DocumentBlock is not in older SDK union
        content: userContent as Anthropic.MessageParam["content"],
      },
    ],
  });

  let fullText = "";
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta" &&
      event.delta.text
    ) {
      fullText += event.delta.text;
      yield { type: "text", content: event.delta.text };
    }
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
}

/** Parses the JSON block from the full analysis text. */
export function extractRecommendations(text: string): AIRecommendation[] {
  // Match ```json ... ``` block (last one wins, in case of multiple)
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (matches.length === 0) return [];

  const lastMatch = matches[matches.length - 1];
  try {
    const parsed = JSON.parse(lastMatch[1].trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r) =>
        typeof r.ticker === "string" &&
        ["BUY", "SELL", "HOLD"].includes(r.action)
    ) as AIRecommendation[];
  } catch {
    return [];
  }
}

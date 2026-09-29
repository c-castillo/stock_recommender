/**
 * Sector lookup for tickers the hand-curated TICKER_SECTOR map doesn't cover.
 *
 * Unmapped tickers used to be classified by the analyst model from the name
 * alone and marked "(inferred)" — which is how BWET, a tanker freight-FUTURES
 * fund, could pass for an energy equity. This asks TradingView's scanner (the
 * same backend the tradingview MCP wraps) for the instrument's real profile:
 * sector/industry for stocks, and for ETFs the fund fields the MCP tools don't
 * surface — focus, asset class, niche and the index tracked.
 *
 * The TradingView profile is mapped onto our sub-sector taxonomy only when the
 * fit is unambiguous; otherwise the sector stays null and the profile text
 * goes to the model as fact to classify from. Results are cached in kv_store.
 */

import { getKv, setKv } from "@/lib/whatsapp/db";
import { SECTORS, sectorOf, type SectorId } from "./sectors";

export interface Classification {
  ticker: string;
  sector: SectorId | null;
  source: "map" | "tradingview" | "unknown";
  /** TradingView profile, e.g. "ETF · Commodities · Broad market · tracks Breakwave Wet Freight Futures Index". */
  profile: string | null;
}

interface TvProfile {
  name: string;
  description: string;
  type: string; // "stock" | "fund" | "dr" | ...
  sector: string | null;
  industry: string | null;
  focus: string | null;
  assetClass: string | null;
  niche: string | null;
  category: string | null;
  index: string | null;
}

const CACHE_PREFIX = "tv_profile:";
const TTL_MS = 30 * 24 * 3600 * 1000;
const MISS_TTL_MS = 7 * 24 * 3600 * 1000;
const MAIN_EXCHANGES = ["NASDAQ", "NYSE", "AMEX", "NYSE ARCA", "CBOE", "BATS"];
const COLUMNS = [
  "name", "type", "description", "sector", "industry", "focus.tr", "asset_class.tr",
  "niche.tr", "category.tr", "index_tracked", "exchange", "market_cap_basic",
];

/** Classify tickers: curated map first, then TradingView (cached). Never throws. */
export async function classifyTickers(tickers: string[]): Promise<Record<string, Classification>> {
  const out: Record<string, Classification> = {};
  const toFetch: string[] = [];
  const cached = new Map<string, TvProfile | null>();

  for (const raw of new Set(tickers.map((t) => t.toUpperCase()))) {
    const mapped = sectorOf(raw);
    const hit = readCache(raw);
    if (hit !== undefined) cached.set(raw, hit);
    if (mapped) {
      out[raw] = { ticker: raw, sector: mapped, source: "map", profile: hit ? describe(hit) : null };
    } else if (hit === undefined) {
      toFetch.push(raw);
    }
  }

  const fetched = await fetchProfiles(toFetch);
  for (const t of toFetch) {
    const p = fetched.get(t) ?? null;
    // Cache a miss too, but only when the request itself succeeded.
    if (fetched.size > 0 || toFetch.length === 0) writeCache(t, p);
    cached.set(t, p);
  }

  for (const [t, p] of cached) {
    if (out[t]) continue;
    out[t] = p
      ? { ticker: t, sector: mapProfile(p), source: "tradingview", profile: describe(p) }
      : { ticker: t, sector: null, source: "unknown", profile: null };
  }
  return out;
}

/** "Energy" / "Commodities & freight (no sub-sector)" style label for prompt tables. */
export function classificationLabel(c: Classification | undefined): string {
  if (!c) return "unclassified — classify it";
  if (c.sector) {
    const label = SECTORS[c.sector].label;
    return c.source === "tradingview" ? `${label} (TradingView: ${c.profile})` : label;
  }
  return c.profile
    ? `no sub-sector fit — TradingView: ${c.profile}`
    : "unclassified — not found on TradingView, classify it";
}

/** Prompt block for discussed tickers outside the curated map. */
export function renderSectorLookup(classes: Record<string, Classification>): string {
  const rows = Object.values(classes)
    .filter((c) => c.source !== "map")
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (rows.length === 0) return "";
  return (
    "\n## Sector lookup (TradingView) — tickers outside the curated sector map\n" +
    "Use these sub-sectors verbatim. Where none fits, classify from the TradingView profile (it is fact, not a guess) and mark it \"(inferred)\"; only a ticker TradingView didn't find is classified from its name.\n" +
    "Ticker|Sub-sector|TradingView profile\n---|---|---\n" +
    rows
      .map((c) => `${c.ticker}|${c.sector ? SECTORS[c.sector].label : "—"}|${c.profile ?? "not found"}`)
      .join("\n") +
    "\n"
  );
}

// ── TradingView ───────────────────────────────────────────────────────────────

async function fetchProfiles(tickers: string[]): Promise<Map<string, TvProfile>> {
  const found = new Map<string, TvProfile>();
  if (tickers.length === 0) return found;
  try {
    const res = await fetch("https://scanner.tradingview.com/america/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({
        filter: [{ left: "name", operation: "in_range", right: tickers }],
        columns: COLUMNS,
        range: [0, tickers.length * 4],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return found;
    const json = (await res.json()) as { data?: { s: string; d: unknown[] }[] };
    // A name can list on several venues (OTC shadows, foreign lines): keep the
    // main-exchange listing, then the larger one.
    const best = new Map<string, { rank: number; cap: number; p: TvProfile }>();
    for (const row of json.data ?? []) {
      const d = Object.fromEntries(COLUMNS.map((c, i) => [c, row.d[i]])) as Record<string, unknown>;
      const name = String(d.name ?? "").toUpperCase();
      if (!tickers.includes(name)) continue;
      const rank = MAIN_EXCHANGES.includes(String(d.exchange)) ? 0 : 1;
      const cap = typeof d.market_cap_basic === "number" ? d.market_cap_basic : 0;
      const prev = best.get(name);
      if (prev && (prev.rank < rank || (prev.rank === rank && prev.cap >= cap))) continue;
      const s = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : null);
      best.set(name, {
        rank,
        cap,
        p: {
          name,
          description: s("description") ?? name,
          type: s("type") ?? "stock",
          sector: s("sector"),
          industry: s("industry"),
          focus: s("focus.tr"),
          assetClass: s("asset_class.tr"),
          niche: s("niche.tr"),
          category: s("category.tr"),
          index: s("index_tracked"),
        },
      });
    }
    for (const [t, v] of best) found.set(t, v.p);
  } catch (err) {
    console.error("[classify] TradingView lookup failed:", err);
  }
  return found;
}

function describe(p: TvProfile): string {
  if (p.type === "fund") {
    const parts = [
      `${p.description} (fund)`,
      p.assetClass,
      p.focus,
      p.niche,
      p.index ? `tracks ${p.index}` : null,
    ];
    return parts.filter(Boolean).join(" · ");
  }
  return [p.description, p.sector, p.industry].filter(Boolean).join(" · ");
}

// ── TradingView profile → sub-sector ──────────────────────────────────────────

const INDUSTRY_SECTOR: Record<string, SectorId> = {
  "Semiconductors": "semis",
  "Electronic Production Equipment": "semicap",
  "Telecommunications Equipment": "optical",
  "Computer Processing Hardware": "ai-infra",
  "Packaged Software": "software",
  "Internet Software/Services": "software",
  "Information Technology Services": "software",
  "Electric Utilities": "power",
  "Alternative Power Generation": "power",
  "Electrical Products": "power",
  "Integrated Oil": "energy",
  "Oil & Gas Production": "energy",
  "Oil Refining/Marketing": "energy",
  "Oil & Gas Pipelines": "energy",
  "Oilfield Services/Equipment": "energy",
  "Contract Drilling": "energy",
  "Coal": "energy",
  "Aerospace & Defense": "industrials",
};

const SECTOR_SECTOR: Record<string, SectorId> = {
  "Finance": "financials",
  "Health Technology": "healthcare",
  "Health Services": "healthcare",
  "Consumer Durables": "consumer",
  "Consumer Non-Durables": "consumer",
  "Consumer Services": "consumer",
  "Retail Trade": "consumer",
  "Producer Manufacturing": "industrials",
  "Transportation": "industrials",
  "Energy Minerals": "energy",
};

function mapProfile(p: TvProfile): SectorId | null {
  const text = [p.description, p.focus, p.niche, p.index].filter(Boolean).join(" ").toLowerCase();
  if (/\bkorea/.test(text)) return "korea";

  if (p.type === "fund") {
    // Only equity funds map onto an equity sub-sector: a commodity or freight
    // futures fund (BWET, USO, GLD) trades its underlying, not the sector.
    if (p.assetClass === "Currency" || p.assetClass === "Commodities") {
      return /bitcoin|ether|crypto/.test(text) ? "crypto" : null;
    }
    if (p.assetClass !== "Equity") return null;
    if (/semiconductor/.test(text)) return "semis";
    if (/bitcoin|crypto|blockchain/.test(text)) return "crypto";
    if (/uranium|nuclear/.test(text)) return "power"; // with OKLO/SMR in the map
    const byFocus: Record<string, SectorId> = {
      "Energy": "energy",
      "Financials": "financials",
      "Health care": "healthcare",
      "Utilities": "power",
      "Industrials": "industrials",
      "Consumer discretionary": "consumer",
      "Consumer staples": "consumer",
      "Large cap": "broad-market",
      "Total market": "broad-market",
    };
    return p.focus ? byFocus[p.focus] ?? null : null;
  }

  return (p.industry ? INDUSTRY_SECTOR[p.industry] : undefined) ?? (p.sector ? SECTOR_SECTOR[p.sector] : undefined) ?? null;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/** undefined = not cached / expired; null = cached miss. */
function readCache(ticker: string): TvProfile | null | undefined {
  try {
    const raw = getKv(CACHE_PREFIX + ticker);
    if (!raw) return undefined;
    const { at, p } = JSON.parse(raw) as { at: number; p: TvProfile | null };
    if (Date.now() - at > (p ? TTL_MS : MISS_TTL_MS)) return undefined;
    return p;
  } catch {
    return undefined;
  }
}

function writeCache(ticker: string, p: TvProfile | null) {
  try {
    setKv(CACHE_PREFIX + ticker, JSON.stringify({ at: Date.now(), p }));
  } catch {
    /* cache is best-effort */
  }
}

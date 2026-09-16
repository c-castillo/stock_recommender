/**
 * Sector taxonomy for the portfolio lens: which sub-sector a ticker trades
 * with, the ETF that stands in for that sector's trend, and the long-only
 * instruments that hedge it.
 *
 * The groups don't trade GICS sectors — they trade themes (memory, optical,
 * neoclouds) that GICS lumps together, and a portfolio of MU + LRCX + CIEN
 * reads as "diversified tech" under GICS while it is really one AI-hardware
 * bet. Sub-sectors are drawn at the level the corpus argues about.
 *
 * Hedges are long-only on purpose: Dr CS hedges with options, and the broker
 * (Zesty) has no options, so every hedge must be something you can BUY —
 * an inverse ETF on the matching index, or a defensive long.
 */

export type SectorId =
  | "memory"
  | "semis"
  | "semicap"
  | "optical"
  | "ai-infra"
  | "power"
  | "software"
  | "crypto"
  | "financials"
  | "energy"
  | "korea"
  | "consumer"
  | "healthcare"
  | "industrials"
  | "broad-market";

export interface Sector {
  label: string;
  /** Umbrella the sub-sector correlates with in a drawdown. */
  theme: "AI hardware" | "AI adjacent" | "Crypto" | "Cyclical" | "Defensive" | "Index";
  /** ETF whose trend and MA200 stand in for the sector. */
  benchmark: string;
  /** Long-only hedges, closest match first. Leverage in the note. */
  hedges: { ticker: string; note: string }[];
}

const SEMI_HEDGES = [
  { ticker: "SSG", note: "-2x DJ US Semiconductors" },
  { ticker: "SOXS", note: "-3x PHLX Semiconductor (SOX)" },
];
const NASDAQ_HEDGES = [
  { ticker: "PSQ", note: "-1x Nasdaq-100" },
  { ticker: "QID", note: "-2x Nasdaq-100" },
  { ticker: "SQQQ", note: "-3x Nasdaq-100" },
];
const SPX_HEDGES = [
  { ticker: "SH", note: "-1x S&P 500" },
  { ticker: "SDS", note: "-2x S&P 500" },
];

export const SECTORS: Record<SectorId, Sector> = {
  memory: {
    label: "Memory & storage",
    theme: "AI hardware",
    benchmark: "SOXX",
    hedges: [...SEMI_HEDGES, { ticker: "PSQ", note: "-1x Nasdaq-100 (looser fit)" }],
  },
  semis: { label: "Semiconductors (compute/logic/analog)", theme: "AI hardware", benchmark: "SMH", hedges: SEMI_HEDGES },
  semicap: { label: "Semi equipment", theme: "AI hardware", benchmark: "SOXX", hedges: SEMI_HEDGES },
  optical: {
    label: "Optical & AI networking",
    theme: "AI hardware",
    benchmark: "SMH",
    hedges: [
      { ticker: "SSG", note: "-2x semis (no optical inverse ETF — correlation proxy)" },
      { ticker: "QID", note: "-2x Nasdaq-100" },
    ],
  },
  "ai-infra": {
    label: "AI infra / neoclouds & DC hosting",
    theme: "AI hardware",
    benchmark: "QQQ",
    hedges: [{ ticker: "QID", note: "-2x Nasdaq-100" }, { ticker: "SOXS", note: "-3x SOX" }],
  },
  power: {
    label: "Power & grid for AI",
    theme: "AI adjacent",
    benchmark: "XLU",
    hedges: [...SPX_HEDGES],
  },
  software: { label: "Software & internet", theme: "AI adjacent", benchmark: "IGV", hedges: NASDAQ_HEDGES },
  crypto: {
    label: "Crypto-linked equities",
    theme: "Crypto",
    benchmark: "IBIT",
    hedges: [{ ticker: "BITI", note: "-1x Bitcoin futures" }],
  },
  financials: {
    label: "Financials & insurance",
    theme: "Cyclical",
    benchmark: "XLF",
    hedges: [{ ticker: "SEF", note: "-1x Financials" }, ...SPX_HEDGES],
  },
  energy: {
    label: "Energy",
    theme: "Cyclical",
    benchmark: "XLE",
    hedges: [{ ticker: "ERY", note: "-2x Energy" }],
  },
  korea: {
    label: "Korea (memory-heavy: Samsung, SK Hynix)",
    theme: "AI hardware",
    benchmark: "EWY",
    hedges: SEMI_HEDGES,
  },
  consumer: { label: "Consumer", theme: "Cyclical", benchmark: "XLY", hedges: SPX_HEDGES },
  healthcare: { label: "Healthcare", theme: "Defensive", benchmark: "XLV", hedges: SPX_HEDGES },
  industrials: { label: "Industrials & defense", theme: "Cyclical", benchmark: "XLI", hedges: SPX_HEDGES },
  "broad-market": { label: "Broad-market ETFs", theme: "Index", benchmark: "SPY", hedges: [...SPX_HEDGES, ...NASDAQ_HEDGES] },
};

/**
 * Defensive longs that offset an AI-hardware book without leverage decay.
 * Only a hedge when the session's macro read supports them (falling yields for
 * TLT, risk-off for GLD/XLU) — they are not automatically negatively correlated.
 */
export const DEFENSIVE_LONGS = [
  { ticker: "GLD", note: "gold" },
  { ticker: "TLT", note: "20y+ Treasuries (works when yields fall)" },
  { ticker: "XLU", note: "utilities" },
  { ticker: "XLP", note: "staples" },
];

/**
 * Tickers the groups hold or discuss. Unlisted tickers are classified by the
 * analyst with the same taxonomy and marked "(inferred)" — add them here when
 * they start recurring.
 */
const TICKER_SECTOR: Record<string, SectorId> = {
  // memory & storage
  MU: "memory", SNDK: "memory", WDC: "memory", STX: "memory", SKHY: "memory",
  // semis
  NVDA: "semis", AMD: "semis", AVGO: "semis", TSM: "semis", INTC: "semis", QCOM: "semis",
  ARM: "semis", MRVL: "semis", TXN: "semis", ADI: "semis", ON: "semis", MCHP: "semis",
  NXPI: "semis", ALAB: "semis", GFS: "semis", SMH: "semis", SOXX: "semis", SOXL: "semis",
  // semicap
  LRCX: "semicap", AMAT: "semicap", KLAC: "semicap", ASML: "semicap", TER: "semicap",
  ONTO: "semicap", ACMR: "semicap",
  // optical & networking
  CIEN: "optical", GLW: "optical", LITE: "optical", COHR: "optical", AAOI: "optical",
  FN: "optical", CRDO: "optical", ANET: "optical", CSCO: "optical", NOK: "optical",
  // AI infra / neoclouds
  NBIS: "ai-infra", CRWV: "ai-infra", WYFI: "ai-infra", IREN: "ai-infra", CIFR: "ai-infra",
  APLD: "ai-infra", CORZ: "ai-infra", SMCI: "ai-infra", DELL: "ai-infra", ORCL: "ai-infra",
  // power
  VRT: "power", GEV: "power", VST: "power", CEG: "power", OKLO: "power", SMR: "power",
  ETN: "power", BE: "power",
  // software & internet
  MSFT: "software", GOOGL: "software", GOOG: "software", META: "software", AMZN: "software",
  PLTR: "software", ADBE: "software", CRM: "software", NOW: "software", TSLA: "consumer",
  // crypto
  BMNR: "crypto", MSTR: "crypto", COIN: "crypto", IBIT: "crypto", HOOD: "crypto",
  // financials
  ROOT: "financials", JPM: "financials", GS: "financials", MS: "financials", XLF: "financials", KRE: "financials",
  // energy
  XOM: "energy", CVX: "energy", XLE: "energy", BWET: "energy",
  // korea
  KORU: "korea", EWY: "korea",
  // broad
  SPY: "broad-market", QQQ: "broad-market", IWM: "broad-market", TQQQ: "broad-market",
};

export function sectorOf(ticker: string): SectorId | null {
  return TICKER_SECTOR[ticker.toUpperCase()] ?? null;
}

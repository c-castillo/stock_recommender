/**
 * One symbol per company.
 *
 * Reports name the same company in different ways: by its US listing (KEP),
 * by a short name (KEPCO), by its local code in Yahoo form (015760.KS) or in
 * Bloomberg form ("015760 KS", "NVDA US"). Each reader of a report picks one,
 * so the same idea used to land under two tickers. Every ticker that enters a
 * digest, and every idea the bundle prints, goes through `normalizeTicker`.
 *
 * No network and no database: a symbol is cleaned by rule, then looked up in
 * the alias table. A name with a US listing takes that listing, because it is
 * the one this book can buy and the one prices and trends are read on.
 */
import { UNDERLYING } from "@/lib/ma200";

/** Bloomberg exchange code → Yahoo suffix, for a local code written "005930 KS". */
const BLOOMBERG_SUFFIX: Record<string, string> = {
  KS: "KS", // Korea Exchange
  KQ: "KQ", // KOSDAQ
  TT: "TW", // Taiwan
  JT: "T", // Tokyo
  JP: "T",
  HK: "HK",
  LN: "L", // London
  GY: "DE", // Xetra
  GR: "DE",
  FP: "PA", // Paris
  NA: "AS", // Amsterdam
  IM: "MI", // Milan
  SM: "MC", // Madrid
  SW: "SW", // SIX Swiss
  SE: "SW",
  AU: "AX", // ASX
  AT: "AX",
  BZ: "SA", // B3
  MM: "MX", // Mexico
  SP: "SI", // Singapore
  MK: "KL", // Kuala Lumpur
  IN: "NS", // NSE India
  DC: "CO", // Copenhagen
  BB: "BR", // Brussels
};

/** Bloomberg codes that only say "listed in the US": "NVDA US", "IBM UN". */
const US_COMPOSITE = new Set(["US", "UN", "UW", "UQ", "UA", "UP", "UR"]);

/**
 * Another way a report writes a company → the symbol this app uses for it.
 * Keys are already cleaned (upper case, Yahoo form). Add a row when a report
 * uses a symbol that is not the US listing; only for a listing that trades
 * on a US exchange, never an OTC one.
 */
const ALIASES: Record<string, string> = {
  // Korea
  KEPCO: "KEP",
  "015760.KS": "KEP",
  "105560.KS": "KB",
  "055550.KS": "SHG",
  "030200.KS": "KT",
  "005490.KS": "PKX",
  POSCO: "PKX",
  "017670.KS": "SKM",
  "316140.KS": "WF", // Woori Financial
  "034220.KS": "LPL", // LG Display
  HYNIX: "SKHY",
  "SK HYNIX": "SKHY",
  // Taiwan, Japan, China
  "2330.TW": "TSM",
  TSMC: "TSM",
  "2303.TW": "UMC",
  "3711.TW": "ASX", // ASE Technology
  "6758.T": "SONY",
  "7203.T": "TM", // Toyota
  "9988.HK": "BABA",
  "9618.HK": "JD",
  "9888.HK": "BIDU",
  // Europe
  "ASML.AS": "ASML",
  "SAP.DE": "SAP",
  "NOVO-B.CO": "NVO",
  "NOKIA.HE": "NOK",
  "ERIC-B.ST": "ERIC",
  "AZN.L": "AZN",
  "SHEL.L": "SHEL",
  "ROP.SW": "ROG.SW", // Roche is ROG in Zurich; ROP is Roper in New York
  // Latin America
  "VALE3.SA": "VALE",
  "PETR4.SA": "PBR",
  "PETR3.SA": "PBR",
  // Share classes a report writes with a slash or a space
  "BRK/B": "BRK.B",
  "BRK B": "BRK.B",
  "BRK-B": "BRK.B",
  GOOG: "GOOGL",
};

/** The original share of a young US listing (lib/ma200.ts) maps back to that listing. */
for (const [us, original] of Object.entries(UNDERLYING)) ALIASES[original] = us;

/** A symbol as a rule can clean it: upper case, no "$", no exchange prefix, Yahoo-form local code. */
export function cleanSymbol(raw: string): string {
  let t = raw.trim().toUpperCase().replace(/^\$/, "");
  // "NASDAQ:NVDA", "KRX: 005930"
  t = t.replace(/^(NASDAQ|NYSE|NYSEARCA|AMEX|ARCA|BATS|KRX|TSE|TWSE|HKEX|LSE)\s*:\s*/, "");
  // "NVDA US EQUITY", "005930 KS Equity"
  t = t.replace(/\s+EQUITY$/, "");
  const m = t.match(/^([A-Z0-9.\-/]+)\s+([A-Z]{2})$/);
  if (m) {
    if (US_COMPOSITE.has(m[2])) t = m[1];
    else if (BLOOMBERG_SUFFIX[m[2]]) t = `${m[1]}.${BLOOMBERG_SUFFIX[m[2]]}`;
  }
  return t;
}

export interface NormalizedTicker {
  /** The symbol to store and group by. */
  ticker: string;
  /** The symbol as the report wrote it, when it was different; null otherwise. */
  from: string | null;
}

/** Clean a symbol and resolve it through the alias table. */
export function normalizeTicker(raw: string): NormalizedTicker {
  const written = raw.trim();
  const cleaned = cleanSymbol(written);
  const ticker = ALIASES[cleaned] ?? cleaned;
  return { ticker, from: ticker === written.toUpperCase() ? null : written };
}

/** A local listing this book cannot buy: a numeric code, or a symbol with an exchange suffix. */
export function isLocalListing(ticker: string): boolean {
  if (/^[A-Z]{1,5}\.[AB]$/.test(ticker)) return false; // BRK.B, a US share class
  return /^\d/.test(ticker) || /\.[A-Z]{1,3}$/.test(ticker);
}

/**
 * Normalize the ideas of one digest. The symbol the report used is kept in the
 * thesis when it was changed and the thesis does not already carry it, so a
 * reader can find the row in the PDF.
 */
export function normalizeIdeas<T extends { ticker: string; thesis: string }>(ideas: T[]): T[] {
  return ideas.map((i) => {
    const { ticker, from } = normalizeTicker(i.ticker ?? "");
    // A change of form only ("NVDA US", "005930 KS") needs no note: the symbol is the same.
    if (!from || cleanSymbol(from) === ticker) return { ...i, ticker };
    const kept = i.thesis.toUpperCase().includes(cleanSymbol(from)) || i.thesis.toUpperCase().includes(from.toUpperCase());
    return { ...i, ticker, thesis: kept ? i.thesis : `${i.thesis} [in the report: ${from}]` };
  });
}

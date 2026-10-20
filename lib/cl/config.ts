/**
 * The Chilean book: a second portfolio at a second broker, analysed apart
 * from the US one with the same playbook.
 *
 * Nothing here is read by the US pipeline, and nothing in the US pipeline's
 * scope (the pinned groups, the Zesty book, the ADD ledger table) is read
 * here. The two share only the WhatsApp database, the chart skills and the
 * rules.
 */
import { join } from "node:path";

/** The one group this analysis reads. It is deliberately NOT one of the US
 *  pinned groups, so its messages never reach the US report. */
export const CL_GROUP = "IPSA & SCL 🇨🇱 Dr Market";

/** The Telegram sources, imported from Telegram Desktop exports
 *  (scripts/cl/telegram.ts) under pseudo-jids that are never selected for the
 *  US analysis. `chat` is the name an export's header must carry to be
 *  imported as that group: Telegram numbers messages per chat, so another
 *  chat under the same jid would overwrite rows. The main analyst is in
 *  neither: no ADD comes from them. */
export interface ClTelegramChat {
  chat: string;
  jid: string;
  group: string;
  about: string;
}
export const CL_TELEGRAM_CHATS: ClTelegramChat[] = [
  {
    chat: "Dividendos Chile",
    jid: "tg:dividendos-chile",
    group: "Dividendos Chile (Telegram)",
    about:
      "A dividend investors' group. Members post forwarded CMF material-fact notices (\"Hecho Esencial\": dividend amounts, " +
      "record and payment dates) and weekly record-date calendars, which are FACTS about dividends; their opinions are chat.",
  },
  {
    chat: "🇨🇱 Hablemos de Chile",
    jid: "tg:hablemos-de-chile",
    group: "Hablemos de Chile (Telegram)",
    about: "A general Chilean-market chat: members' views on Chilean stocks, the economy and politics. Opinions are chat; forwarded notices and data are dated facts.",
  },
];
/** The dividends chat, which the bundle's per-name dividend history reads. */
export const CL_TELEGRAM_GROUP = CL_TELEGRAM_CHATS[0].group;
export const CL_TELEGRAM_GROUPS = CL_TELEGRAM_CHATS.map((c) => c.group);

/** Every group the Chilean analysis reads. */
export const CL_SOURCES = [CL_GROUP, ...CL_TELEGRAM_GROUPS];

export const CL_DIR = join(process.cwd(), ".whatsapp", "cl");
export const CL_REPORTS = join(CL_DIR, "reports");
export const CL_HOLDINGS = join(CL_DIR, "holdings");
export const CL_STATEMENTS = join(CL_DIR, "statements");
export const CL_LEDGER = join(CL_DIR, "adds.json");
export const CL_BOOK_HISTORY = join(CL_DIR, "book-history.json");

/** Itaú's own IT NOW S&P IPSA ETF: Yahoo has no series for the ^IPSA index,
 *  and this one is also what the benchmark row would buy. */
export const BENCHMARK = "CFMITNIPSA.SN";

/** Commission per side as a fraction of the order: Itaú charges 0.15%
 *  (confirmed by the user on 2026-10-19). */
export const COMMISSION_PC = 0.0015;
export const COMMISSION_VERIFIED = true;

/** Fallback yearly yield of the money-market fund when a statement does not
 *  carry two unit values to compute it from. */
export const CASH_APR_FALLBACK = 0.035;

/** Same risk budget as the US book: 0.75% of the book between entry and stop. */
export const RISK_PER_POSITION = 0.0075;

/** Santiago tickers trade on Yahoo with the .SN suffix; indices, FX and
 *  futures keep their own symbols. */
export function yahooSymbol(ticker: string): string {
  return /[.^=]/.test(ticker) ? ticker : `${ticker}.SN`;
}

export function fromYahoo(symbol: string): string {
  return symbol.replace(/\.SN$/, "");
}

export type ClSectorId =
  | "power"
  | "water"
  | "gas"
  | "banks"
  | "pension-funds"
  | "retail"
  | "malls"
  | "beverages"
  | "conglomerates"
  | "forestry"
  | "lithium-mining"
  | "steel-iron"
  | "transport"
  | "telecom-tech"
  | "construction"
  | "free-zone";

export interface ClSector {
  label: string;
  /** Umbrella the sub-sector falls with in a sell-off. */
  theme: "Regulated utilities" | "Financials" | "Domestic consumption" | "Commodities" | "Industrial";
}

export const CL_SECTORS: Record<ClSectorId, ClSector> = {
  power: { label: "Power generation", theme: "Regulated utilities" },
  water: { label: "Water & sanitation", theme: "Regulated utilities" },
  gas: { label: "Gas distribution", theme: "Regulated utilities" },
  banks: { label: "Banks", theme: "Financials" },
  "pension-funds": { label: "Pension fund managers (AFP)", theme: "Financials" },
  retail: { label: "Retail", theme: "Domestic consumption" },
  malls: { label: "Malls & real estate", theme: "Domestic consumption" },
  beverages: { label: "Beverages & food", theme: "Domestic consumption" },
  "free-zone": { label: "Free-trade zone", theme: "Domestic consumption" },
  conglomerates: { label: "Fuel & forestry conglomerates", theme: "Commodities" },
  forestry: { label: "Pulp & forestry", theme: "Commodities" },
  "lithium-mining": { label: "Lithium & mining", theme: "Commodities" },
  "steel-iron": { label: "Iron ore & steel", theme: "Commodities" },
  transport: { label: "Airlines & shipping", theme: "Industrial" },
  "telecom-tech": { label: "Telecom & IT services", theme: "Industrial" },
  construction: { label: "Construction & engineering", theme: "Industrial" },
};

/** Curated map, at the level the group argues about. A ticker missing here is
 *  classified by the analyst and marked "(inferred)". */
export const CL_SECTOR_OF: Record<string, ClSectorId> = {
  COLBUN: "power", ENELCHILE: "power", ENELAM: "power", ECL: "power", AESANDES: "power",
  "AGUAS-A": "water", IAM: "water",
  NTGCLGAS: "gas",
  CHILE: "banks", BSANTANDER: "banks", BCI: "banks", ITAUCL: "banks", SECURITY: "banks",
  HABITAT: "pension-funds", PROVIDA: "pension-funds", CUPRUM: "pension-funds", PLANVITAL: "pension-funds",
  CENCOSUD: "retail", FALABELLA: "retail", RIPLEY: "retail", SMU: "retail", FORUS: "retail",
  PARAUCO: "malls", MALLPLAZA: "malls", CENCOMALLS: "malls",
  "ANDINA-B": "beverages", CCU: "beverages", CONCHATORO: "beverages",
  ZOFRI: "free-zone",
  COPEC: "conglomerates", QUINENCO: "conglomerates",
  CMPC: "forestry",
  "SQM-B": "lithium-mining", "SQM-A": "lithium-mining",
  CAP: "steel-iron",
  LTM: "transport", VAPORES: "transport",
  ENTEL: "telecom-tech", SONDA: "telecom-tech",
  SALFACORP: "construction",
};

export function clSectorOf(ticker: string): ClSectorId | null {
  return CL_SECTOR_OF[ticker.toUpperCase()] ?? null;
}

/** The IPSA's members as tracked here, for breadth (Chartizard 8: new 52-week
 *  highs against lows) and for the banks of Chartizard 4. Kept by hand: a
 *  ticker Yahoo cannot price is reported and skipped, not guessed. */
export const IPSA_MEMBERS = [
  "AGUAS-A", "ANDINA-B", "BCI", "BSANTANDER", "CAP", "CCU", "CENCOMALLS", "CENCOSUD", "CHILE",
  "CMPC", "COLBUN", "CONCHATORO", "COPEC", "ECL", "ENELAM", "ENELCHILE", "ENTEL", "FALABELLA",
  "IAM", "ITAUCL", "LTM", "MALLPLAZA", "PARAUCO", "QUINENCO", "RIPLEY", "SALFACORP", "SMU",
  "SONDA", "SQM-B", "VAPORES",
];

export const CL_BANKS = ["CHILE", "BSANTANDER", "BCI", "ITAUCL"];

/** What moves the Chilean market from outside, read every run. */
export const CL_MACRO: { symbol: string; label: string }[] = [
  { symbol: "CLP=X", label: "USD/CLP (up = weaker peso)" },
  { symbol: "HG=F", label: "Copper futures" },
  { symbol: "ECH", label: "iShares MSCI Chile (USD)" },
  { symbol: "EEM", label: "Emerging markets (USD)" },
  { symbol: "SPY", label: "S&P 500" },
];

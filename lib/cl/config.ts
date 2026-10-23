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
  NTGCLGAS: "gas", LIPIGAS: "gas",
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

/** Names this book never recommends: the user works at Walmart Chile, and
 *  these are its direct competitors (supermarkets and big-box retail), so a
 *  position in them is a conflict of interest. CENCOMALLS is listed because
 *  Cencosud controls it. They stay in the sector tables as valuation peers. */
export const CL_RESTRICTED: Record<string, string> = {
  CENCOSUD: "Jumbo, Santa Isabel, Easy",
  CENCOMALLS: "controlled by Cencosud",
  FALABELLA: "Tottus, Sodimac",
  SMU: "Unimarc, Alvi, Mayorista 10",
};

/** Names the user asked to track before they are bought: each run prints the
 *  plan against the live price and the report gives each a 💡 row. A plan is
 *  the user's, set by hand; it is not an ADD and never a buy on its own. */
export interface ClWatch {
  added: string;
  source: string;
  plan: string;
  /** Closing-basis levels the run compares with the last close. */
  levels: { label: string; price: number; when: "above" | "below" }[];
}
export const CL_WATCHLIST: Record<string, ClWatch> = {
  ENTEL: {
    added: "2026-10-21",
    source:
      "User request after a two-leg review on 2026-10-21; Elliott count by @koke87918480 on X (21-10, not the main analyst): " +
      "impulse from the 3.300 June low, wave 3 in progress, 1.618 target ~4.418 met by the 4.450 wick on 21-10, wave 5 ~4.950.",
    plan:
      "Not before the 2026-11-02 results. A BUY needs the Q3 statements to keep the business growing with a normal tax line " +
      "(the 12-month profit leans on a tax credit and deferred tax), then either a wave-4 pullback holding 4.160–4.250 or a " +
      "daily close over 4.505 (0.618 of 5.250→3.300). Stop 3.980 on a close (under the wave-1 high); targets 4.700, then ~4.950. " +
      "Size the 5% low end (~1.100 sh). The count is void on a close under 3.660.",
    levels: [
      { label: "count void", price: 3660, when: "below" },
      { label: "stop for an entry", price: 3980, when: "below" },
      { label: "wave-4 zone top", price: 4250, when: "below" },
      { label: "breakout (0.618)", price: 4505, when: "above" },
    ],
  },
  ILC: {
    added: "2026-10-21",
    source:
      "User request after a two-leg review on 2026-10-21 (CMF análisis razonado 2026-06). Holds 40,29% of HABITAT (held) and of AAISA.",
    plan:
      "Passes every FUNDAMENTAL BUY test (H1 profit +44,7% from the bank, pensions, insurance and health; P/E ~7,2 against an " +
      "AFP median ~10; ROE 26,1%; dividend 860, 30% payout) but has no XBRL split: say so. Wait for HABITAT's 2026-10-27 results " +
      "(the AFPs' Q3 encaje carries the US rate-derivative losses the main analyst flagged on 14-10), then BUY the 5% low end " +
      "(~190 sh) near 24.000–24.400 while above a rising MA200; stop on a close under the MA200 (~21.600). It adds look-through " +
      "AFP exposure on top of HABITAT.",
    levels: [
      { label: "stop (MA200)", price: 21600, when: "below" },
      { label: "55-day support", price: 23080, when: "below" },
      { label: "new high", price: 26000, when: "above" },
    ],
  },
  AAISA: {
    added: "2026-10-21",
    source: "User request after a two-leg review on 2026-10-21 (CMF análisis razonado 2026-06).",
    plan:
      "Good business at the wrong price. H1 profit +160%, much of it Andina Vida (IFRS 17, lumpy) and FX translation; P/E ~7,2, " +
      "ROE ~18–20%, yield 2,6% (growth role). 34% over its MA200 after a near-vertical run, falling back from 707, and crowded " +
      "in the Telegram groups. BUY only on a pullback that holds the 55-day (~557) or the August breakout (~500), after the " +
      "2026-11-23 results confirm the growth; stop under the MA200. ILC already owns 40% of it.",
    levels: [
      { label: "MA200", price: 461, when: "below" },
      { label: "breakout zone", price: 500, when: "below" },
      { label: "55-day", price: 557, when: "below" },
    ],
  },
  NTGCLGAS: {
    added: "2026-10-21",
    source: "User request after a two-leg review on 2026-10-21 (CMF XBRL 2026-06: no EARNINGS QUALITY flag).",
    plan:
      "Passes every FUNDAMENTAL BUY test (business +12% YTD, +15% in the quarter; P/E 9,7 against a gas median 11,7; business ROE " +
      "19,4%; net debt 1,1× EBITDA). Recurring dividend small (~25, 3,6%: growth role; the 54 of Dec-2025 was a one-off). Not " +
      "before the 2026-10-23 results. Then BUY the 5% low end (~6.800 sh) on a close over 700 (clears the 44.052-sh ask wall) or " +
      "a pullback holding the 55-day (~662); stop on a close under the MA200 (~630).",
    levels: [
      { label: "stop (MA200)", price: 630, when: "below" },
      { label: "55-day support", price: 662, when: "below" },
      { label: "breakout", price: 700, when: "above" },
    ],
  },
  LIPIGAS: {
    added: "2026-10-21",
    source: "User request after a two-leg review on 2026-10-21 (CMF XBRL 2026-06: no EARNINGS QUALITY flag).",
    plan:
      "The better business (ROE 33%, business ROE 36,5%; quarterly dividends, 604 over 12 months = 6,0%, 82% payout: a DIVIDEND " +
      "candidate) but P/E 13,6 over the gas median 11,7, and +14% in 10 sessions to a new high of 10.100 on a thin book. " +
      "BUY on a pullback into 9.200–9.500 (the September breakout); stop on a close under the MA200 (~8.450); ~450–500 sh. " +
      "The next provisional dividend is usually declared late November.",
    levels: [
      { label: "stop (MA200)", price: 8450, when: "below" },
      { label: "pullback zone top", price: 9500, when: "below" },
    ],
  },
  SOQUICOM: {
    added: "2026-10-21",
    source: "User request after a two-leg review on 2026-10-21 (CMF análisis razonado 2026-06).",
    plan:
      "Not buyable under the rules: no presencia bursátil (a BET at most, never a DIVIDEND holding, no capital-gains " +
      "exemption), barely trades (5% spread), and sits under a falling MA200. Fundamentals are fine (H1 business up sharply, " +
      "100% payout, ~7,5% trailing yield, no financial debt, SQM-controlled). Revisit only if presencia bursátil returns and it " +
      "closes above a rising MA200 (~379).",
    levels: [{ label: "MA200", price: 379, when: "above" }],
  },
  ECL: {
    added: "2026-10-22",
    source: "IPSA sweep on 2026-10-22 (CMF XBRL and análisis razonado 2026-06; TradingView levels).",
    plan:
      "The nearest IPSA candidate: business +7% YTD (EBITDA +11%), P/E 8,2 against a power median 10,6, business ROE 18%, " +
      "net debt 1,2× equity; deferred tax lowers the profit (no flattering flag). Fails one test: the Q2 business fell 16% " +
      "(lower generation, spot purchases). Yield 3,1%: a GROWTH role. Not before the 2026-10-28 results. BUY only if Q3 " +
      "business grows year on year (2026 EBITDA guidance 690–760 implies a softer second half, so this is not given), then the " +
      "5% low end (~2.500 sh) on a close back over the 50-day (~1.895) or a pullback holding 1.774–1.800 (the October low); " +
      "stop on a close under the MA200 (~1.717). Adds to power, where COLBUN, ENELCHILE and ENELAM are held.",
    levels: [
      { label: "stop (MA200)", price: 1717, when: "below" },
      { label: "October low", price: 1774, when: "below" },
      { label: "50-day reclaim", price: 1895, when: "above" },
      { label: "September high", price: 1950, when: "above" },
    ],
  },
  BCI: {
    added: "2026-10-22",
    source: "IPSA sweep on 2026-10-22 (TradingView fundamentals: banks file no XBRL at the CMF).",
    plan:
      "Close but not yet: ROE 14,2%, P/E 12,7 against a bank median 13,0, above a rising MA200 with presencia. Fails the " +
      "quarter test (Q2 profit -2,7% on revenue +6,9%), and the 21- and 50-day are above the price (RRG weakening). Yield 2,3%: " +
      "a GROWTH role. Not before the 2026-10-30 results. BUY only if Q3 profit grows year on year, then the 5% low end (~73 sh) " +
      "on a close back over the 50-day (~66.000) while the MA200 holds; stop on a close under ~61.900. A candidate to replace " +
      "BSANTANDER (lagging) rather than add a third bank.",
    levels: [
      { label: "stop (under the MA200)", price: 61900, when: "below" },
      { label: "MA200", price: 62700, when: "below" },
      { label: "50-day reclaim", price: 66000, when: "above" },
    ],
  },
  INGEVEC: {
    added: "2026-10-22",
    source: "IGPA sweep on 2026-10-22 (CMF XBRL 2026-06: no EARNINGS QUALITY flag; presencia bursátil yes).",
    plan:
      "Passes every FUNDAMENTAL BUY test: business +64% YTD and +97% in the quarter, P/E 10,5 against construction peers " +
      "(SALFACORP 16,7, BESALCO 12,2, EISA 11,7), business ROE 22,7%, cash conversion 1,2×, net debt 0,7× equity. Yield 2,4%: " +
      "a GROWTH role. 8% over a rising MA200, under the 227 high of February. Buyable now until 2026-10-27 (results due " +
      "2026-11-06), else after them. BUY the 5% low end (~21.000 sh) with a limit at 214–218 (the book is thin, ~CLP 50M a " +
      "day: never chase the ask) or on a close over 227; stop on a close under the MA200 (~201).",
    levels: [
      { label: "stop (MA200)", price: 201, when: "below" },
      { label: "55-day", price: 212, when: "below" },
      { label: "new high", price: 227, when: "above" },
    ],
  },
  ENELGXCH: {
    added: "2026-10-22",
    source: "IGPA sweep on 2026-10-22 (CMF XBRL and análisis razonado 2026-06; presencia bursátil yes).",
    plan:
      "A DIVIDEND candidate: yield ~6,9% on a 70% payout (covered), business +12% YTD, P/E 9,5 against a power median 10,6, " +
      "business ROE 21,7%, almost no net debt, no EARNINGS QUALITY flag. Fails one test: Q2 EBITDA -22,7% on lower hydrology. " +
      "93,6% owned by ENELCHILE (held), so a small float. Not before the 2026-10-28 results. BUY only if Q3 holds the business " +
      "year on year, then ~7.900 sh on a pullback to the 55-day (~571) or a close over 602; stop on a close under the MA200 " +
      "(~541). Power is already crowded (COLBUN, ENELCHILE, ENELAM, ECL watched): fund it from the COLBUN trim, not new money.",
    levels: [
      { label: "stop (MA200)", price: 541, when: "below" },
      { label: "55-day", price: 571, when: "below" },
      { label: "high", price: 602, when: "above" },
    ],
  },
  PUCOBRE: {
    added: "2026-10-22",
    source: "IGPA sweep on 2026-10-22 (CMF XBRL 2026-06; presencia bursátil yes).",
    plan:
      "Copper miner with a strong run: business +72% YTD and +99% in the quarter, business ROE 32,7%, net debt 0,6× equity. " +
      "Fails two tests narrowly: operating cash flow is 0,68× profit (flag) and P/E 12,7 sits at the mining median. Yield 1,7%: " +
      "a GROWTH role, and a copper-price bet. The Q3 date is not filed yet: check it before any order (no buy within 10 days). " +
      "BUY only if Q3 shows cash conversion back near 1×, then ~270 sh while above a rising MA200 (~16.300); stop on a close " +
      "under it. 25% under its 22.998 January high; the book is thin, use limits.",
    levels: [
      { label: "stop (MA200)", price: 16300, when: "below" },
      { label: "recovery", price: 18000, when: "above" },
    ],
  },
};

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

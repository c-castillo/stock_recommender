/**
 * Everything the Chilean analysis reads, in one Markdown file — the
 * counterpart of the MCP `analysis_bundle` for the US book, built from the
 * Itaú statement, Yahoo's Santiago prices and the IPSA group.
 *
 *   pnpm exec tsx scripts/cl/bundle.mts [--full-detail-days N] [--days 90] [--out file]
 *
 * It also records today's value of the book in `.whatsapp/cl/book-history.json`
 * (one row per date, replaced on a re-run), which is where the performance
 * windows come from: the broker's statement has no history of its own.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BENCHMARK, CASH_APR_FALLBACK, CL_BANKS, CL_BOOK_HISTORY, CL_GROUP, CL_HOLDINGS, CL_TELEGRAM_CHATS, CL_TELEGRAM_GROUPS, CL_MACRO, CL_REPORTS,
  CL_SECTORS, CL_SECTOR_OF, COMMISSION_PC, COMMISSION_VERIFIED, IPSA_MEMBERS, RISK_PER_POSITION, clSectorOf, fromYahoo, yahooSymbol,
} from "@/lib/cl/config";
import { CMF_DIR, CMF_ISSUER, isDividendNotice, latestFiledPeriod, loadCmfIndex, nextDuePeriod, noticeBody } from "@/lib/cl/cmf";
import { renderFinancials, type CmfStatements } from "@/lib/cl/financials";
import type { ClStatement } from "@/lib/cl/holdings";
import { clAddStatus, loadClLedger } from "@/lib/cl/ledger";
import { loadClRoles, suggestRole } from "@/lib/cl/roles";
import { fetchDailyCloses, type DailyClose } from "@/lib/market/history";
import { fetchRrg, heading, type RrgPoint } from "@/lib/market/rrg";
import { renderMediaDigestBlock, renderTextBlock } from "@/lib/ai/content-loader";
import { getGroupContent, listGroupJidsByName, mainAnalystAliases } from "@/lib/whatsapp/db";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
const fullDetailDays = Number(opt("full-detail-days") ?? 7);
const windowDays = Number(opt("days") ?? 90);
// The Telegram groups are busy (Dividendos Chile posts ~400 messages a
// month); their dividend posts are pulled out over a year below, so their
// chat is read over a shorter window.
const telegramDays = Number(opt("telegram-days") ?? 30);
const outPath = opt("out") ?? join(CL_REPORTS, `${TODAY}.bundle.md`);

// ── Helpers ──────────────────────────────────────────────────────────────────

const clp = (n: number | null | undefined, d = 0) =>
  n == null || !isFinite(n) ? "—" : n.toLocaleString("es-CL", { minimumFractionDigits: d, maximumFractionDigits: d });
const pc = (x: number | null | undefined, d = 1) => (x == null || !isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)}%`);
const share = (x: number) => `${(100 * x).toFixed(1)}%`;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

interface Tech {
  last: number;
  lastDate: string;
  ma: Record<21 | 55 | 144 | 200, number | null>;
  /** Direction of each average over the last 5 sessions. */
  dir: Record<21 | 55 | 144, "↑" | "↓" | "—">;
  /** % change of the MA200 over 20 sessions — the playbook's slope. */
  slope200: number | null;
  hi52: number;
  lo52: number;
  newHigh: boolean;
  newLow: boolean;
  ret: { m1: number | null; m3: number | null; m6: number | null; ytd: number | null };
  hi6m: { close: number; date: string };
}

function tech(bars: DailyClose[]): Tech | null {
  if (bars.length < 30) return null;
  const c = bars.map((b) => b.close);
  const n = c.length;
  const smaAt = (len: number, end: number) => (end >= len ? avg(c.slice(end - len, end)) : null);
  const ma = { 21: smaAt(21, n), 55: smaAt(55, n), 144: smaAt(144, n), 200: smaAt(200, n) };
  const dirOf = (len: number) => {
    const now = smaAt(len, n);
    const before = smaAt(len, n - 5);
    return now == null || before == null ? "—" : now >= before ? "↑" : "↓";
  };
  const ma200ago = smaAt(200, n - 20);
  const year = c.slice(-252);
  const prior = c.slice(-253, -1);
  const back = (k: number) => (n > k ? c[n - 1] / c[n - 1 - k] - 1 : null);
  const ytdBase = bars.filter((b) => b.date < `${TODAY.slice(0, 4)}-01-01`).at(-1)?.close;
  const six = bars.slice(-126);
  const top = six.reduce((a, b) => (b.close > a.close ? b : a));
  return {
    last: c[n - 1],
    lastDate: bars[n - 1].date,
    ma,
    dir: { 21: dirOf(21), 55: dirOf(55), 144: dirOf(144) },
    slope200: ma[200] != null && ma200ago != null ? (ma[200] / ma200ago - 1) * 100 : null,
    hi52: Math.max(...year),
    lo52: Math.min(...year),
    newHigh: prior.length > 0 && c[n - 1] >= Math.max(...prior),
    newLow: prior.length > 0 && c[n - 1] <= Math.min(...prior),
    ret: { m1: back(21), m3: back(63), m6: back(126), ytd: ytdBase ? c[n - 1] / ytdBase - 1 : null },
    hi6m: { close: top.close, date: top.date },
  };
}

/** Fetch with a little concurrency: Yahoo throttles a burst of ~100. */
async function closesFor(symbols: string[]): Promise<Map<string, DailyClose[]>> {
  const out = new Map<string, DailyClose[]>();
  const queue = [...new Set(symbols)];
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) out.set(s, await fetchDailyCloses(s, "2y"));
    })
  );
  return out;
}

function santiagoPhase(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Santiago", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  if (["Sat", "Sun"].includes(get("weekday"))) return "weekend";
  if (minutes < 9 * 60 + 30) return "before the open";
  if (minutes < 16 * 60) return "open";
  return "after the close";
}

// ── Inputs ───────────────────────────────────────────────────────────────────

const holdingFiles = existsSync(CL_HOLDINGS) ? readdirSync(CL_HOLDINGS).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
if (!holdingFiles.length) {
  console.error("No Itaú statement has been read: run scripts/cl/holdings.ts <statement.pdf> first.");
  process.exit(2);
}
const statement: ClStatement = JSON.parse(readFileSync(join(CL_HOLDINGS, holdingFiles.at(-1)!), "utf8"));
const firstSeen = new Map<string, string>();
for (const f of holdingFiles) {
  const s: ClStatement = JSON.parse(readFileSync(join(CL_HOLDINGS, f), "utf8"));
  for (const p of s.positions) if (!firstSeen.has(p.ticker)) firstSeen.set(p.ticker, s.asOf);
}
const ledger = loadClLedger().filter((a) => a.active);
const held = statement.positions.map((p) => p.ticker);
const tickers = [...new Set([...held, ...ledger.map((a) => a.ticker), ...IPSA_MEMBERS])];

const [closes, rrg] = await Promise.all([
  closesFor([...tickers.map(yahooSymbol), BENCHMARK, ...CL_MACRO.map((m) => m.symbol)]),
  fetchRrg([...new Set([...held, ...ledger.map((a) => a.ticker), ...IPSA_MEMBERS])].map(yahooSymbol), BENCHMARK),
]);
// Yahoo's Santiago daily bars carry the same close for days on end (63 of
// 125 sessions for the IPSA ETF in Oct 2026), so its averages and slopes are
// approximate. TradingView's scanner has the exchange's own levels: it is the
// check on every "above/below the MA200" call.
type TvRow = {
  close: number; sma50: number; sma200: number; m1: number; m3: number; ytd: number; hi: number; lo: number;
  /** Dividend fields; null where TradingView has none (a payout of 0 means unknown). */
  yieldPc: number | null; payout: number | null; nextEx: string | null; nextAmount: number | null;
  lastEx: string | null; dps: number | null; dpsYoy: number | null; yearsPaying: number | null;
  /** TradingView's own P/E (12 months), P/B and ROE: the check on the CMF figures, and the only ones for banks and AFPs. */
  pe: number | null; pb: number | null; roe: number | null;
};
async function tradingView(names: string[]): Promise<Map<string, TvRow>> {
  const out = new Map<string, TvRow>();
  try {
    const res = await fetch("https://scanner.tradingview.com/chile/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers: names.map((t) => `BCS:${t.replace(/-/g, "_")}`) },
        columns: [
          "close", "SMA50", "SMA200", "Perf.1M", "Perf.3M", "Perf.YTD", "price_52_week_high", "price_52_week_low",
          "dividends_yield_current", "dividend_payout_ratio_ttm", "dividend_ex_date_upcoming", "dividend_amount_upcoming",
          "dividend_ex_date_recent", "dps_common_stock_prim_issue_fy", "dps_common_stock_prim_issue_yoy_growth_fy",
          "continuous_dividend_payout", "price_earnings_ttm", "price_book_fq", "return_on_equity",
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    for (const r of (await res.json()).data ?? []) {
      const [close, sma50, sma200, m1, m3, ytd, hi, lo, yld, payout, nextEx, nextAmount, lastEx, dps, dpsYoy, years, pe, pb, roe] = r.d;
      const day = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);
      out.set(r.s.replace(/^BCS:/, "").replace(/_/g, "-"), {
        close, sma50, sma200, m1, m3, ytd, hi, lo,
        yieldPc: yld != null ? yld / 100 : null,
        payout: payout ? payout / 100 : null,
        nextEx: day(nextEx), nextAmount: nextAmount ?? null, lastEx: day(lastEx),
        dps: dps ?? null, dpsYoy: dpsYoy != null ? dpsYoy / 100 : null, yearsPaying: years ?? null,
        pe: pe ?? null, pb: pb ?? null, roe: roe != null ? roe / 100 : null,
      });
    }
  } catch {
    /* the section says it is missing */
  }
  return out;
}
const tv = await tradingView([...new Set([...held, ...ledger.map((a) => a.ticker), ...IPSA_MEMBERS, ...Object.keys(CL_SECTOR_OF), "CFMITNIPSA"])]);
const staleBars = new Map<string, number>();
for (const [sym, bars] of closes) {
  const last = bars.slice(-125);
  staleBars.set(fromYahoo(sym), last.filter((b, i) => i > 0 && b.close === last[i - 1].close).length);
}

const techOf = new Map<string, Tech | null>();
for (const [sym, bars] of closes) techOf.set(fromYahoo(sym), tech(bars));
const rrgOf = new Map<string, RrgPoint>(rrg.map((p) => [fromYahoo(p.ticker), p]));
const unpriced = tickers.filter((t) => !techOf.get(t));

// ── The book at today's prices ───────────────────────────────────────────────

const rows = statement.positions.map((p) => {
  const t = techOf.get(p.ticker) ?? null;
  const price = t?.last ?? p.statementPrice;
  return { p, t, price, value: p.shares * price, sector: clSectorOf(p.ticker) };
});
const fundValue = statement.funds.reduce((a, f) => a + f.value, 0);
const cashLike = fundValue + statement.cash + statement.pendingSettlement;
const equity = rows.reduce((a, r) => a + r.value, 0);
const book = equity + cashLike;
const cashApr = statement.fundYield ?? CASH_APR_FALLBACK;
const userRoles = loadClRoles();
const roleOf = (ticker: string) => {
  if (userRoles[ticker]) return { role: userRoles[ticker].role, label: userRoles[ticker].role };
  const r = tv.get(ticker);
  const role = suggestRole(r?.yieldPc ?? null, r ? r.close > r.sma200 : null, cashApr);
  return { role, label: `${role} (suggested)` };
};
const statementAge = Math.round((Date.parse(TODAY) - Date.parse(statement.asOf)) / 86_400_000);

// Record today's value; performance is measured on this series.
mkdirSync(CL_REPORTS, { recursive: true });
type HistRow = { date: string; value: number; equity: number; cash: number; statement: string };
const history: HistRow[] = existsSync(CL_BOOK_HISTORY) ? JSON.parse(readFileSync(CL_BOOK_HISTORY, "utf8")) : [];
const histNext = [...history.filter((h) => h.date !== TODAY), { date: TODAY, value: book, equity, cash: cashLike, statement: statement.asOf }]
  .sort((a, b) => a.date.localeCompare(b.date));
writeFileSync(CL_BOOK_HISTORY, JSON.stringify(histNext, null, 1));

// ── Sections ─────────────────────────────────────────────────────────────────

const out: string[] = [];
const say = (s = "") => out.push(s);
const bench = techOf.get(BENCHMARK.replace(/\.SN$/, "")) ?? techOf.get(fromYahoo(BENCHMARK)) ?? null;

say(`# Chilean book — analysis bundle for ${TODAY}`);
say();
say(`Santiago clock: ${santiagoPhase()} (session 09:30–16:00 America/Santiago). ` +
  `Prices are Yahoo's last regular-session prices: closes of ${bench?.lastDate ?? "?"} unless the session is open.`);
say(`Broker: Itaú Corredora de Bolsa. No connector: the book is the statement of ${statement.asOf} ` +
  `(${statementAge} day(s) old) at today's prices. Trades made after that date are NOT in it.`);
if (statementAge > 7)
  say(`⚠ The statement is ${statementAge} days old. Say so at the top of the report; any order sized on it assumes nothing was traded since.`);
if (unpriced.length) say(`Not priced by Yahoo (skipped): ${unpriced.join(", ")}.`);
say();

say("## Portfolio (CLP)");
say();
say("Ticker|Role|Sector|Shares|Avg cost|Price|Value|Weight|P&L on cost|Divs received|MA200 slope|vs MA200|21/55/144|52w hi / lo|RRG vs IPSA");
say("---|---|---|---|---|---|---|---|---|---|---|---|---|---|---");
for (const r of [...rows].sort((a, b) => b.value - a.value)) {
  const t = r.t;
  const q = rrgOf.get(r.p.ticker);
  say([
    r.p.ticker,
    roleOf(r.p.ticker).label,
    r.sector ? CL_SECTORS[r.sector].label : `${r.p.rubro ?? "?"} (Itaú rubro)`,
    clp(r.p.shares),
    clp(r.p.avgCost, 2),
    clp(r.price, 2),
    clp(r.value),
    share(r.value / book),
    pc(r.price / r.p.avgCost - 1),
    clp(r.p.dividendsReceived),
    t?.slope200 != null ? `${t.slope200 >= 0 ? "↑+" : "↓"}${t.slope200.toFixed(2)}%` : "—",
    t?.ma[200] ? pc(r.price / t.ma[200] - 1) : "—",
    t ? `${t.dir[21]}${t.dir[55]}${t.dir[144]}` : "—",
    t ? `${clp(t.hi52, 2)} / ${clp(t.lo52, 2)}` : "—",
    q ? `${q.quadrant} (from ${q.from}, ${heading(q)})` : "—",
  ].join("|"));
}
say();
say(`Equity CLP ${clp(equity)} · cash-like CLP ${clp(cashLike)} (${share(cashLike / book)}): ` +
  statement.funds.map((f) => `${f.code} ${f.name ?? ""} CLP ${clp(f.value)}`).join(", ") +
  `, account cash CLP ${clp(statement.cash)}, pending settlement CLP ${clp(statement.pendingSettlement)}.`);
say(`Book CLP ${clp(book)} (≈ USD ${statement.usdClp ? clp(book / statement.usdClp) : "?"} at the statement's ${statement.usdClp ?? "?"} CLP/USD).`);
say(`Projected dividends (statement): CLP ${clp(statement.projectedDividends.next30)} in 0–30 days, CLP ${clp(statement.projectedDividends.next31to90)} in 31–90 days.`);
say();

say("### Cross-check: TradingView levels (authoritative for above/below the averages)");
say("Yahoo's Santiago bars repeat the previous close on many sessions (count below, of the last 125): its MA slopes, 1M changes, " +
  "breadth and RRG are approximate. Decide every MA200 call on TradingView's SMA200; cite Yahoo's slope only as a direction, and say so in the report.");
say();
say("Ticker|TV close|TV SMA50|TV SMA200|vs TV SMA200|TV 1M|TV 3M|TV YTD|TV 52w hi / lo|Yahoo repeated closes");
say("---|---|---|---|---|---|---|---|---|---");
for (const t of [...held, ...ledger.map((a) => a.ticker).filter((x) => !held.includes(x)), "CFMITNIPSA"]) {
  const r = tv.get(t);
  const tvPc = (x?: number) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);
  say(r
    ? `${t}|${clp(r.close, 2)}|${clp(r.sma50, 2)}|${clp(r.sma200, 2)}|${pc(r.close / r.sma200 - 1)}|${tvPc(r.m1)}|${tvPc(r.m3)}|${tvPc(r.ytd)}|${clp(r.hi, 2)} / ${clp(r.lo, 2)}|${staleBars.get(t) ?? staleBars.get(fromYahoo(BENCHMARK)) ?? "—"}`
    : `${t}|not on TradingView's scan|—|—|—|—|—|—|—|${staleBars.get(t) ?? "—"}`);
}
if (!tv.size) say("\n⚠ TradingView did not answer: every MA call rests on Yahoo's approximate bars. Say so at the top of the report.");
say();

say("### Dividends and roles (POSITION ROLES)");
say(`Yield is TradingView's current yield (last fiscal year's dividend per share over today's price). The hurdle is the fund's ${(100 * cashApr).toFixed(2)}%; ` +
  "a dividend holding is expected to clear it by a point. Yield on cost is that dividend over the book's average cost. " +
  "Roles marked \"suggested\" are a guess from the numbers until the user sets them (scripts/cl/roles.ts); a user's role is binding.");
say();
say("Ticker|Role|Yield|Yield on cost|vs hurdle|DPS (FY)|DPS y/y|Payout|Years paying|Last ex-date|Next ex-date (amount)|Received (statement)|CLP a year at this DPS");
say("---|---|---|---|---|---|---|---|---|---|---|---|---");
for (const r of [...rows].sort((a, b) => (tv.get(b.p.ticker)?.yieldPc ?? 0) - (tv.get(a.p.ticker)?.yieldPc ?? 0))) {
  const d = tv.get(r.p.ticker);
  const y = d?.yieldPc ?? null;
  say([
    r.p.ticker,
    roleOf(r.p.ticker).label,
    pc(y).replace("+", ""),
    d?.dps != null ? pc(d.dps / r.p.avgCost).replace("+", "") : "—",
    y != null ? `${y >= cashApr ? "+" : ""}${(100 * (y - cashApr)).toFixed(1)} pt` : "—",
    d?.dps != null ? clp(d.dps, 2) : "—",
    pc(d?.dpsYoy),
    d?.payout != null ? `${Math.round(100 * d.payout)}%` : "unknown",
    d?.yearsPaying != null ? String(d.yearsPaying) : "—",
    d?.lastEx ?? "—",
    d?.nextEx ? `${d.nextEx} (CLP ${clp(d.nextAmount, 2)})` : "not announced",
    clp(r.p.dividendsReceived),
    d?.dps != null ? clp(d.dps * r.p.shares) : "—",
  ].join("|"));
}
const income = rows.reduce((a, r) => a + (tv.get(r.p.ticker)?.dps ?? 0) * r.p.shares, 0);
say();
say(`The book's equity yields CLP ${clp(income)} a year at last year's dividends (${share(income / equity)} of the equity; the fund pays ${(100 * cashApr).toFixed(2)}%). ` +
  "Chilean companies pay most of it once a year, around April–May, after the shareholders' meeting.");
say();

say("### Highest close in the last six months (trailing-stop reference)");
say("Entry dates are not on the statement: the first statement that shows each position is given, and the high is a six-month one.");
say();
say("Ticker|6M high close|Date|Live vs high|First on a statement");
say("---|---|---|---|---");
for (const r of rows) {
  const t = r.t;
  say(`${r.p.ticker}|${t ? clp(t.hi6m.close, 2) : "—"}|${t?.hi6m.date ?? "—"}|${t ? pc(r.price / t.hi6m.close - 1) : "—"}|${firstSeen.get(r.p.ticker)}`);
}
say();

say("## Sector exposure (longs, % of the whole book)");
say();
const bySector = new Map<string, number>();
const byTheme = new Map<string, number>();
for (const r of rows) {
  const label = r.sector ? CL_SECTORS[r.sector].label : `unmapped: ${r.p.rubro ?? r.p.ticker}`;
  const theme = r.sector ? CL_SECTORS[r.sector].theme : "unmapped";
  bySector.set(label, (bySector.get(label) ?? 0) + r.value);
  byTheme.set(theme, (byTheme.get(theme) ?? 0) + r.value);
}
say("Sub-sector|% of book|Flag");
say("---|---|---");
for (const [k, v] of [...bySector].sort((a, b) => b[1] - a[1])) say(`${k}|${share(v / book)}|${v / book > 0.35 ? "⚠ over 35%" : ""}`);
say();
say("Theme|% of book|Flag");
say("---|---|---");
for (const [k, v] of [...byTheme].sort((a, b) => b[1] - a[1])) say(`${k}|${share(v / book)}|${v / book > 0.6 ? "⚠ over 60%" : ""}`);
say();

say("## Performance");
say();
const histOn = (date: string) => histNext.filter((h) => h.date <= date).at(-1) ?? null;
const ago = (days: number) => new Date(Date.parse(TODAY) - days * 86_400_000).toISOString().slice(0, 10);
const windows: [string, string][] = [["3M", ago(91)], ["6M", ago(182)], ["YTD", `${TODAY.slice(0, 4)}-01-01`]];
say("Window|Book|IPSA ETF|Cash (fund)|Book − IPSA");
say("---|---|---|---|---");
for (const [name, from] of windows) {
  const h = histOn(from);
  const covered = h != null && histNext[0].date <= from;
  const bookRet = covered ? book / h!.value - 1 : null;
  const b = name === "3M" ? bench?.ret.m3 : name === "6M" ? bench?.ret.m6 : bench?.ret.ytd;
  const days = (Date.parse(TODAY) - Date.parse(from)) / 86_400_000;
  const cashRet = Math.pow(1 + cashApr, days / 365) - 1;
  say(`${name}|${covered ? pc(bookRet) : `unknown (history since ${histNext[0].date})`}|${pc(b)}|${pc(cashRet)}|${bookRet != null && b != null ? pc(bookRet - b) : "—"}`);
}
const peak = histNext.reduce((a, h) => (h.value > a.value ? h : a));
say();
say(`Drawdown from the recorded peak (${peak.date}, CLP ${clp(peak.value)}): ${pc(book / peak.value - 1)}. ` +
  `The series starts ${histNext[0].date}; until it covers a window, say the book's return over it is unknown — ` +
  "never infer it from the positions' P&L on cost, which mixes years of entries and excludes dividends paid out.");
say();

say("## Breadth and the banks (Chartizard 4 and 8)");
say();
const members = IPSA_MEMBERS.map((t) => [t, techOf.get(t)] as const).filter(([, t]) => t);
const highs = members.filter(([, t]) => t!.newHigh).map(([k]) => k);
const lows = members.filter(([, t]) => t!.newLow).map(([k]) => k);
const aboveRising = members.filter(([, t]) => t!.ma[200] && t!.last > t!.ma[200]! && (t!.slope200 ?? 0) > 0).length;
const near = (t: Tech, x: number) => Math.abs(t.last / x - 1) <= 0.03;
say(`IPSA members priced: ${members.length}. New 52-week closing highs today: ${highs.length} (${highs.join(", ") || "none"}); ` +
  `new lows: ${lows.length} (${lows.join(", ") || "none"}).`);
say(`Within 3% of the 52-week high: ${members.filter(([, t]) => near(t!, t!.hi52)).map(([k]) => k).join(", ") || "none"}. ` +
  `Within 3% of the low: ${members.filter(([, t]) => near(t!, t!.lo52)).map(([k]) => k).join(", ") || "none"}.`);
say(`Above a rising MA200: ${aboveRising} of ${members.length}.`);
say();
say("Bank|Price|MA200 slope|vs MA200|1M|3M|RRG vs IPSA");
say("---|---|---|---|---|---|---");
for (const b of CL_BANKS) {
  const t = techOf.get(b);
  const q = rrgOf.get(b);
  say(`${b}|${t ? clp(t.last, 2) : "—"}|${t?.slope200 != null ? t.slope200.toFixed(2) + "%" : "—"}|${t?.ma[200] ? pc(t.last / t.ma[200] - 1) : "—"}|${pc(t?.ret.m1)}|${pc(t?.ret.m3)}|${q ? `${q.quadrant} ${heading(q)}` : "—"}`);
}
say();

say("## IPSA members: trend and rotation (for watchlist and swaps)");
say();
say("Ticker|Sector|Price|MA200 slope|vs MA200|21/55/144|1M|3M|YTD|RRG vs IPSA");
say("---|---|---|---|---|---|---|---|---|---");
for (const [k, t] of members) {
  const q = rrgOf.get(k);
  const s = clSectorOf(k);
  say(`${k}${held.includes(k) ? " (held)" : ""}|${s ? CL_SECTORS[s].label : "?"}|${clp(t!.last, 2)}|${t!.slope200 != null ? t!.slope200.toFixed(2) + "%" : "—"}|${t!.ma[200] ? pc(t!.last / t!.ma[200] - 1) : "—"}|${t!.dir[21]}${t!.dir[55]}${t!.dir[144]}|${pc(t!.ret.m1)}|${pc(t!.ret.m3)}|${pc(t!.ret.ytd)}|${q ? `${q.quadrant} (${heading(q)})` : "—"}`);
}
say();

say("## Macro");
say();
say("Series|Last|1M|3M|YTD|MA200 slope|vs MA200");
say("---|---|---|---|---|---|---");
for (const m of [{ symbol: BENCHMARK, label: "IPSA (IT NOW S&P IPSA ETF)" }, ...CL_MACRO]) {
  const t = techOf.get(fromYahoo(m.symbol));
  say(`${m.label}|${t ? clp(t.last, 2) : "—"}|${pc(t?.ret.m1)}|${pc(t?.ret.m3)}|${pc(t?.ret.ytd)}|${t?.slope200 != null ? t.slope200.toFixed(2) + "%" : "—"}|${t?.ma[200] ? pc(t.last / t.ma[200] - 1) : "—"}`);
}
say();

say("## Costs and the hurdle");
say();
say(`- Commission: ${(100 * COMMISSION_PC).toFixed(2)}% per side, ${(200 * COMMISSION_PC).toFixed(2)}% round trip` +
  (COMMISSION_VERIFIED ? "." : " — UNVERIFIED for Itaú: say so once in the report's Costs line."));
say(`- Cash: the money-market fund ${statement.funds[0]?.code ?? ""} yields ${(100 * cashApr).toFixed(2)}% a year` +
  (statement.fundYield != null ? " (from its unit values on the statement)" : " (fallback, not measured)") +
  `, CLP ${clp((cashLike * cashApr) / 52)} a week on today's cash-like balance.`);
say(`- Risk budget: ${(100 * RISK_PER_POSITION).toFixed(2)}% of the book = CLP ${clp(book * RISK_PER_POSITION)} between entry and stop per position.`);
say("- Orders are placed by hand in the Itaú app. Itaú does not accept stop orders: every stop is a closing-basis stop the next run decides.");
say();

say("## ★ Chilean ADD ledger [HIGHEST PRIORITY]");
say();
const aliases = mainAnalystAliases();
if (aliases.length) say(`In the chats and digests the main analyst is written as: ${aliases.join(", ")}. Write "the main analyst" in the report.`);
if (!ledger.length) {
  say("The ledger is empty. When the main analyst explicitly buys or adds a Chilean name in the messages below, record it " +
    "with `pnpm exec tsx scripts/cl/adds.ts record TICKER --entry <price> --on <date> --note \"…\" [--invalidation <level>]`.");
} else {
  say("Ticker|Status|Entry|Live|MA200 slope|Invalidation|Added|Age|Note");
  say("---|---|---|---|---|---|---|---|---");
  for (const a of ledger) {
    const t = techOf.get(a.ticker) ?? null;
    const { status, ageDays } = clAddStatus(a, t?.last ?? null, t?.slope200 ?? null);
    say(`${a.ticker}|${status}|${a.entryPrice ?? "—"}|${t ? clp(t.last, 2) : "—"}|${t?.slope200 != null ? t.slope200.toFixed(2) + "%" : "—"}|${a.invalidation ?? "—"}|${a.addedOn}|${ageDays}d|${a.note ?? ""}`);
  }
}
say();

// ── The corpus ───────────────────────────────────────────────────────────────

const sections: [string, number, string][] = [
  [CL_GROUP, windowDays, "The main analyst's group. Sparse: a quiet week is normal and is not a stale sync. Senders are opaque ids except the main analyst."],
  ...CL_TELEGRAM_CHATS.map((c): [string, number, string] => [
    c.group,
    telegramDays,
    `${c.about} Telegram, imported from an export: it is only as fresh as the last export. The main analyst is not in it: nothing here is an ADD.`,
  ]),
];
for (const [group, days, about] of sections) {
  const jids = listGroupJidsByName([group]);
  const content = getGroupContent(jids, days, 6000);
  const textRows = content.filter((r) => r.body && !/^\[(image|document|video|audio|sticker)\]$/.test(r.body));
  const mediaRows = content.filter((r) => r.media_digest != null && (r.media_type === "image" || r.media_type === "document"));
  const undigested = content.filter((r) => r.media_digest == null && (r.media_type === "image" || r.media_type === "document")).length;
  const newest = content[0];
  say(`## Source: ${group} (last ${days} days)`);
  say();
  if (!jids.length) {
    say(`⚠ ${group} is not in the database${group !== CL_GROUP ? ": import its export with scripts/cl/telegram.ts" : ""}.`);
    say();
    continue;
  }
  const stored = newest ?? getGroupContent(jids, 3650, 1)[0];
  say(`${textRows.length} text messages and ${mediaRows.length} digested files. Newest message stored: ` +
    `${stored ? new Date(stored.ts * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "none"}.` +
    (undigested ? ` ${undigested} file(s) are not digested and invisible here.` : "") +
    (!newest && stored ? " ⚠ Nothing in the window: the export is stale. Say so; do not read silence as a quiet market." : ""));
  say(about);
  say();
  say(renderTextBlock(textRows));
  say(renderMediaDigestBlock(mediaRows, { transcriptSince: Math.floor(Date.now() / 1000) - fullDetailDays * 86400 }));
}

// Dividend notices over a year, for the names the book holds or watches: the
// Telegram groups' forwarded material facts are the record of what each
// company declared, which TradingView's yield only summarises.
const watched = [...new Set([...held, ...ledger.map((a) => a.ticker), ...(opt("watch")?.split(",") ?? [])])];
const names = new Map(watched.map((t) => {
  const p = statement.positions.find((x) => x.ticker === t);
  const word = (p?.company ?? "").replace(/^(ADMINISTRADORA DE FONDOS DE PENSIONES|EMPRESAS|EMBOTELLADORA|BANCO DE|VINA|ZONA FRANCA DE)\s+/i, "").split(/\s+/)[0];
  return [t, [t.replace(/-.*$/, ""), word].filter((w) => w && w.length > 3).map((w) => w.toUpperCase())];
}));
const plain = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
const year = getGroupContent(listGroupJidsByName(CL_TELEGRAM_GROUPS), 365, 100000)
  .filter((r) => r.body && /dividend|reparto de utilidades/i.test(r.body));
const isNotice = (b: string) => /hecho esencial/i.test(b);
const tidy = (b: string) =>
  b.replace(/📅\s*Nuevo Hecho Esencial!\s*/g, "Hecho Esencial: ").replace(/Abrir PDF \([^)]*\)/g, "").replace(/\s+/g, " ").trim();
say("## Dividend mentions, last 365 days (Telegram groups, held and watched names)");
say();
say("Formal notices (Hecho Esencial, forwarded from the CMF feed) first, then members' posts; up to six per name, newest first. " +
  "A notice is a declaration: say whether it is provisional (provisorio) or final (definitivo). A member's post is hearsay until a notice or the price data confirms it.");
say();
for (const t of watched) {
  const keys = (names.get(t) ?? [t]).map(plain);
  const all = year.filter((r) => keys.some((k) => plain(r.body!).includes(k)));
  const hits = [...all.filter((r) => isNotice(r.body!)).slice(0, 3), ...all.filter((r) => !isNotice(r.body!))].slice(0, 6);
  say(`### ${t}${hits.length ? "" : " — nothing in the year"}`);
  for (const r of hits) {
    const text = tidy(r.body!);
    say(`- [${new Date(r.ts * 1000).toISOString().slice(0, 10)}] ${isNotice(r.body!) ? "NOTICE · " : `${r.sender ?? "?"}: `}${text.length > (isNotice(r.body!) ? 900 : 400) ? text.slice(0, isNotice(r.body!) ? 900 : 400) + " …" : text}`);
  }
  say();
}

// The CMF's own record, synced by scripts/cl/cmf.mts before the bundle: the
// notices are what the company declared, the calendar is the results date.
const cmf = loadCmfIndex();
const noticeDays = 90;
const sinceNotices = new Date(Date.parse(TODAY) - noticeDays * 86_400_000).toISOString().slice(0, 10);
say("## CMF filings (the regulator's record — FACTS)");
say();
say("Material facts (hechos esenciales) the companies filed with the CMF, their statements calendar and their latest análisis razonado, " +
  "from cmfchile.cl. A notice is the company's own declaration and outranks a Telegram post about it; a dividend notice says whether it is " +
  "provisional (provisorio), final (definitivo) or only proposed to the shareholders' meeting. \"OCR\" marks a notice read from a scan: " +
  "check a figure against its PDF before an order rests on it. \"Next due\" is the CMF's deadline for the quarter's statements, the date " +
  "NO BUY INTO ITS OWN RESULTS uses (companies often file a few days before it).");
say();
if (!Object.keys(cmf).length) {
  say("⚠ Not synced: run `pnpm exec tsx scripts/cl/cmf.mts sync`. Say in the report that the CMF record was not read.");
} else {
  say("Ticker|Next statements due|Days|Last filed period|Filed by|Notices (90d)|Dividend notices (365d)|Synced");
  say("---|---|---|---|---|---|---|---");
  for (const t of watched) {
    const r = cmf[t];
    if (!r) {
      say(`${t}|${CMF_ISSUER[t] ? "not synced" : "no CMF id"}|—|—|—|—|—|—`);
      continue;
    }
    const next = nextDuePeriod(r.calendar, TODAY);
    const last = latestFiledPeriod(r.calendar, TODAY);
    const days = next ? Math.round((Date.parse(next.due) - Date.parse(TODAY)) / 86_400_000) : null;
    say([
      t,
      next ? `${next.due} (${next.year}-${next.month})` : "not set",
      days != null ? `${days}${days <= 10 ? " ⚠" : ""}` : "—",
      r.report?.period ?? "—",
      last ? last.due : "—",
      r.notices.filter((n) => n.at.slice(0, 10) >= sinceNotices).length,
      r.notices.filter(isDividendNotice).length,
      `${r.syncedAt.slice(0, 10)}${r.error ? " ⚠ last sync failed" : ""}`,
    ].join("|"));
  }
  say();
  for (const t of watched) {
    const r = cmf[t];
    if (!r) continue;
    const shown = r.notices.filter((n) => n.at.slice(0, 10) >= sinceNotices || isDividendNotice(n)).slice(0, 8);
    say(`### ${t} (CMF)${shown.length ? "" : ` — no notice in ${noticeDays} days, no dividend notice in the year`}`);
    for (const n of shown) {
      const body = !n.text ? "(not downloaded yet)"
        : n.scanned ? `(a scan OCR could not read: ${join(CMF_DIR, n.text)})`
        : noticeBody(readFileSync(join(CMF_DIR, n.text), "utf8"));
      say(`- [${n.at}] ${n.materia}${isDividendNotice(n) ? " · DIVIDEND" : ""}${n.ocr ? " · OCR" : ""}: ${body.length > 900 ? body.slice(0, 900) + " …" : body}`);
    }
    if (r.report?.text)
      say(`- Análisis razonado ${r.report.period}: ${join(CMF_DIR, r.report.text)} — read it for a name you BUY or SELL, and for one whose results came out since the last report.`);
    else if (r.report) say(`- Statements ${r.report.period} filed; the CMF has no análisis razonado for it${CMF_ISSUER[t]?.bank ? " (banks publish theirs on their own site)" : ""}.`);
    say();
  }
}

// ── Financial statements ─────────────────────────────────────────────────────

// From the XBRL each issuer files with the CMF (lib/cl/financials.ts): where
// the profit comes from, and P/E, P/B and ROE on twelve months.
say("## Financial statements (CMF XBRL — FACTS) and valuation");
say();
say("Each name's latest statements as filed with the CMF, split by where the profit before tax comes from. **Business** is the result of " +
  "running the company; exchange differences, indexation (unidades de reajuste), biological revaluation and other income/expenses/gains are " +
  "accounting or one-off lines; finance and associates recur. Deferred tax is the part of the tax that is not paid in cash this period. " +
  "Twelve months = this year to date + last December's year − last year's same year to date. P/E and P/B use the TradingView close, and a " +
  "filing in USD is converted at the statement's CLP/USD. Apply the playbook's EARNINGS QUALITY rule: a P/E is only as good as the profit under it.");
say();
// A P/E is read against the sector's, never alone.
const sectorsWatched = [...new Set(watched.map(clSectorOf).filter((x): x is NonNullable<typeof x> => !!x))];
if (sectorsWatched.length) {
  say("Sector peers (TradingView, twelve months; * = in the book or the ledger):");
  say();
  say("Sub-sector|Ticker|P/E|P/B|ROE|Median P/E of the sub-sector");
  say("---|---|---|---|---|---");
  for (const sec of sectorsWatched) {
    const peers = Object.entries(CL_SECTOR_OF).filter(([, x]) => x === sec).map(([t]) => t).filter((t) => tv.has(t));
    const pes = peers.map((t) => tv.get(t)!.pe).filter((x): x is number => x != null && x > 0).sort((a, b) => a - b);
    const median = pes.length ? (pes.length % 2 ? pes[(pes.length - 1) / 2] : (pes[pes.length / 2 - 1] + pes[pes.length / 2]) / 2) : null;
    peers.forEach((t, i) => {
      const d = tv.get(t)!;
      say(`${i ? "" : CL_SECTORS[sec].label}|${t}${watched.includes(t) ? "*" : ""}|${clp(d.pe, 1)}|${clp(d.pb, 2)}|${d.roe != null ? share(d.roe) : "—"}|${i ? "" : clp(median, 1)}`);
    });
  }
  say();
}

const usdClp = statement.usdClp ?? null;
for (const t of watched) {
  const r = cmf[t];
  const d = tv.get(t);
  const price = d?.close ?? rows.find((x) => x.p.ticker === t)?.price ?? techOf.get(t)?.last;
  const tvLine = d ? `TradingView: P/E ${clp(d.pe, 2)}, P/B ${clp(d.pb, 2)}, ROE ${d.roe != null ? share(d.roe) : "—"}.` : "TradingView did not answer.";
  const cur = r?.statements ? (JSON.parse(readFileSync(join(CMF_DIR, r.statements), "utf8")) as CmfStatements) : null;
  if (!cur || !price) {
    const why = CMF_ISSUER[t]?.bank ? "a bank: it files under the banking registry, outside the CMF's XBRL; its profit is not split here (provisions, " +
        "indexation of the UF book and trading gains drive it — read its results release)"
      : r?.report ? "no XBRL at the CMF (the AFPs file their statements as PDF only; the return on the encaje, the reserve each AFP invests " +
        "alongside its funds, is the line that swings their profit — read it in the análisis razonado)"
      : "not synced";
    say(`#### ${t} — ${why}.`);
    say(tvLine);
    say();
    continue;
  }
  const dec = r!.december ? (JSON.parse(readFileSync(join(CMF_DIR, r!.december), "utf8")) as CmfStatements) : null;
  for (const l of renderFinancials(t, cur, dec, price, usdClp, d ? { pe: d.pe, pb: d.pb, roe: d.roe } : null)) say(l);
  say();
}

// ── Prior reports (NOT evidence) ─────────────────────────────────────────────

const prior = existsSync(CL_REPORTS) ? readdirSync(CL_REPORTS).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f.slice(0, 10) < TODAY).sort() : [];
say("## Your own prior reports — NOT EVIDENCE");
say();
say(prior.length
  ? `The previous report is ${join(CL_REPORTS, prior.at(-1)!)}. Read its 🩺 and 💡 sections for what was decided; never cite it as a source (Evidence Discipline 1).`
  : "None: this is the first Chilean report. There is no prior verdict, no order status and no scorecard yet.");

writeFileSync(outPath, out.join("\n") + "\n");
console.log(`${outPath} — ${out.join("\n").length.toLocaleString()} chars; book CLP ${clp(book)}; ${unpriced.length} unpriced`);

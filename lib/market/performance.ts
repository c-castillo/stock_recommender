/**
 * Portfolio performance, money-weighted, against the benchmarks the book
 * actually competes with.
 *
 * Two facts the local snapshots can't supply: the value at the start of the
 * year and the deposits/withdrawals since. Both live in the performance anchor
 * (kv_store, refreshed from the Zesty MCP tools); everything else — the current
 * value, benchmark returns, the drawdown — is computed live here.
 *
 * Returns use Modified Dietz, weighting each flow by the fraction of the period
 * it was invested. Dividing the gain by the year-start value instead would
 * credit June/July deposits with a full year of compounding.
 */

import { getPerformanceAnchor, type PerformanceAnchor } from "@/lib/whatsapp/db";

/** Benchmarks: broad market, the Nasdaq the book's beta comes from, and semis. */
const BENCHMARKS = ["SPY", "QQQ", "SMH"];

/** One measurement window. 3M and 6M show whether recent decisions are working
 *  while YTD still carries the whole year — a book can be up YTD and losing
 *  money every month since. */
export type WindowId = "3M" | "6M" | "YTD";

export interface WindowReading {
  window: WindowId;
  startDate: string;
  startValue: number;
  netFlows: number;
  gain: number;
  /** Money-weighted (Modified Dietz) return over the window, %. */
  returnPct: number;
  benchmarks: { ticker: string; pct: number }[];
}

export interface PerformanceReading {
  asOf: string;
  currentValue: number;
  windows: WindowReading[];
  peak: { date: string; value: number };
  drawdownPct: number;
  anchorAsOf: string;
  source: string;
}

const days = (from: string, to: Date) =>
  Math.round((to.getTime() - new Date(from + "T00:00:00Z").getTime()) / 86400000);

/** Benchmark total return from each window start to now. */
async function benchmarkReturns(
  starts: { window: WindowId; date: string }[]
): Promise<Map<WindowId, { ticker: string; pct: number }[]>> {
  const earliest = starts.reduce((a, b) => (a.date < b.date ? a : b)).date;
  const start = Math.floor(new Date(earliest + "T00:00:00Z").getTime() / 1000) - 10 * 86400;
  const series = await Promise.all(
    BENCHMARKS.map(async (ticker) => {
      try {
        const url =
          `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}` +
          `?interval=1d&period1=${start}&period2=${Math.floor(Date.now() / 1000)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const r = (await res.json())?.chart?.result?.[0];
        const ts: number[] = r?.timestamp ?? [];
        const closes: (number | null)[] =
          r?.indicators?.adjclose?.[0]?.adjclose ?? r?.indicators?.quote?.[0]?.close ?? [];
        const bars: { t: number; c: number }[] = [];
        ts.forEach((t, i) => {
          const c = closes[i];
          if (c != null && isFinite(c)) bars.push({ t, c });
        });
        return bars.length > 0 ? { ticker, bars } : null;
      } catch {
        return null;
      }
    })
  );

  const out = new Map<WindowId, { ticker: string; pct: number }[]>();
  for (const { window, date } of starts) {
    const cutoff = new Date(date + "T23:59:59Z").getTime() / 1000;
    const row: { ticker: string; pct: number }[] = [];
    for (const s of series) {
      if (!s) continue;
      const base = s.bars.filter((b) => b.t <= cutoff).at(-1)?.c;
      const last = s.bars.at(-1)?.c;
      if (base != null && last != null) row.push({ ticker: s.ticker, pct: (last / base - 1) * 100 });
    }
    out.set(window, row);
  }
  return out;
}

/** Modified Dietz over [startDate, asOf], given the value at startDate. */
function dietz(
  startDate: string,
  startValue: number,
  flows: { date: string; amount: number }[],
  currentValue: number,
  asOf: Date
): { netFlows: number; gain: number; returnPct: number } {
  const period = Math.max(days(startDate, asOf), 1);
  let netFlows = 0;
  let weighted = 0;
  for (const f of flows) {
    if (f.date <= startDate) continue;
    const elapsed = Math.min(Math.max(days(startDate, new Date(f.date + "T00:00:00Z")), 0), period);
    netFlows += f.amount;
    weighted += f.amount * ((period - elapsed) / period);
  }
  const gain = currentValue - startValue - netFlows;
  const denom = startValue + weighted;
  return { netFlows, gain, returnPct: denom > 0 ? (gain / denom) * 100 : 0 };
}

/** Portfolio value at (or just before) a date, from the anchor's weekly series. */
function valueAt(anchor: PerformanceAnchor, date: string): { date: string; value: number } | null {
  if (date <= anchor.yearStartDate) return { date: anchor.yearStartDate, value: anchor.yearStartValue };
  const prior = (anchor.series ?? []).filter((p) => p.date <= date).at(-1);
  return prior ? { date: prior.date, value: prior.value } : null;
}

function shiftMonths(from: Date, months: number): string {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** Null when no anchor has been recorded yet — the analysis then says so. */
export async function fetchPerformance(currentValue: number): Promise<PerformanceReading | null> {
  const anchor = getPerformanceAnchor();
  if (!anchor) return null;

  const asOf = new Date();
  const wanted: { window: WindowId; date: string }[] = [
    { window: "3M", date: shiftMonths(asOf, 3) },
    { window: "6M", date: shiftMonths(asOf, 6) },
    { window: "YTD", date: anchor.yearStartDate },
  ];

  const resolved = wanted
    .map(({ window, date }) => ({ window, start: valueAt(anchor, date) }))
    .filter((w): w is { window: WindowId; start: { date: string; value: number } } => w.start !== null);

  const benchmarks = await benchmarkReturns(
    resolved.map((w) => ({ window: w.window, date: w.start.date }))
  );

  const windows: WindowReading[] = resolved.map(({ window, start }) => ({
    window,
    startDate: start.date,
    startValue: start.value,
    ...dietz(start.date, start.value, anchor.flows, currentValue, asOf),
    benchmarks: benchmarks.get(window) ?? [],
  }));

  const peak = currentValue > anchor.peak.value
    ? { date: asOf.toISOString().slice(0, 10), value: currentValue }
    : anchor.peak;

  return {
    asOf: asOf.toISOString().slice(0, 10),
    currentValue,
    windows,
    peak,
    drawdownPct: peak.value > 0 ? (currentValue / peak.value - 1) * 100 : 0,
    anchorAsOf: anchor.asOf,
    source: anchor.source,
  };
}

export function renderPerformance(p: PerformanceReading | null): string {
  if (!p) {
    return (
      "\n## Performance\nNo performance anchor recorded — year-start value and cash flows unknown, " +
      "so YTD return cannot be stated. Do not infer performance from position P&L alone.\n"
    );
  }
  const pc = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const usd = (n: number) =>
    `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const bench = (w: WindowReading, t: string) => w.benchmarks.find((b) => b.ticker === t);

  let out =
    `\n## Performance (money-weighted, net of deposits/withdrawals)\n` +
    `Current value ${num(p.currentValue)} · peak ${num(p.peak.value)} on ${p.peak.date} · ` +
    `drawdown from peak **${pc(p.drawdownPct)}**\n\n` +
    "Window|From|StartVal|NetFlows|Gain|Return|SPY|QQQ|SMH|vs SPY\n" +
    "---|---|---|---|---|---|---|---|---|---\n";

  for (const w of p.windows) {
    const spy = bench(w, "SPY")?.pct;
    out +=
      `${w.window}|${w.startDate}|${num(w.startValue)}|${usd(w.netFlows)}|${usd(w.gain)}|` +
      `**${pc(w.returnPct)}**|${spy != null ? pc(spy) : "—"}|` +
      `${bench(w, "QQQ") ? pc(bench(w, "QQQ")!.pct) : "—"}|` +
      `${bench(w, "SMH") ? pc(bench(w, "SMH")!.pct) : "—"}|` +
      `${spy != null ? pc(w.returnPct - spy) : "—"}\n`;
  }

  out +=
    `\n3M and 6M say whether recent decisions are working; YTD carries the whole year. ` +
    `Anchor as of ${p.anchorAsOf} (${p.source}) — start values and cash flows are broker data, ` +
    `benchmarks and the current value are live.\n`;
  return out;
}

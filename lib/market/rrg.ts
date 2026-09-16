/**
 * Relative Rotation Graph (RRG) readings from weekly Yahoo closes.
 *
 * RRG plots each instrument's relative strength against a benchmark on two
 * axes — RS-Ratio (trend of relative strength) and RS-Momentum (its rate of
 * change) — both normalised around 100. Rotation runs clockwise:
 * Improving → Leading → Weakening → Lagging.
 *
 * The JdK formulas are proprietary; this is the common open approximation:
 *   RS        = price / benchmark
 *   RS-Ratio  = 100 + z-score over 52w of RS / SMA10(RS)
 *   RS-Mom    = 100 + z-score over 52w of the 4-week change in RS-Ratio
 * Levels will not match StockCharts' numbers exactly; quadrants and tail
 * direction are what the analysis uses.
 */

const WEEKS_SMA = 10;
const WEEKS_Z = 52;
const WEEKS_MOM = 4;
const TAIL = 4;

export type RrgQuadrant = "Leading" | "Weakening" | "Lagging" | "Improving";

export interface RrgPoint {
  ticker: string;
  benchmark: string;
  ratio: number;
  momentum: number;
  quadrant: RrgQuadrant;
  /** Quadrant TAIL weeks ago, to show where the rotation came from. */
  from: RrgQuadrant;
  /** Weekly change over the tail, for the direction of travel. */
  dRatio: number;
  dMomentum: number;
  asOf: string;
}

async function fetchWeeklyCloses(ticker: string): Promise<Map<number, number>> {
  const closes = new Map<number, number>();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1wk&range=3y`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return closes;
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const cl: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    ts.forEach((t, i) => {
      const c = cl[i];
      // Key by week start (UTC day) so the two series align on the same bars.
      if (c != null && isFinite(c)) closes.set(Math.floor(t / 86400), c);
    });
  } catch {
    /* empty map → ticker skipped */
  }
  return closes;
}

function sma(xs: number[], n: number, i: number): number | null {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += xs[k];
  return s / n;
}

function zscoreLast(xs: (number | null)[], i: number, n: number): number | null {
  const win = xs.slice(Math.max(0, i - n + 1), i + 1).filter((x): x is number => x != null);
  if (win.length < n / 2 || xs[i] == null) return null;
  const mean = win.reduce((a, b) => a + b, 0) / win.length;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
  return sd === 0 ? 0 : ((xs[i] as number) - mean) / sd;
}

function quadrant(ratio: number, momentum: number): RrgQuadrant {
  if (ratio >= 100) return momentum >= 100 ? "Leading" : "Weakening";
  return momentum >= 100 ? "Improving" : "Lagging";
}

function computeRrg(
  ticker: string,
  benchmark: string,
  px: Map<number, number>,
  bench: Map<number, number>
): RrgPoint | null {
  const days = [...px.keys()].filter((d) => bench.has(d)).sort((a, b) => a - b);
  if (days.length < WEEKS_SMA + WEEKS_Z / 2 + WEEKS_MOM + TAIL) return null;

  const rs = days.map((d) => px.get(d)! / bench.get(d)!);
  const norm = rs.map((v, i) => {
    const m = sma(rs, WEEKS_SMA, i);
    return m == null ? null : v / m;
  });
  const ratio = norm.map((_, i) => {
    const z = zscoreLast(norm, i, WEEKS_Z);
    return z == null ? null : 100 + z;
  });
  const roc = ratio.map((v, i) =>
    v != null && i >= WEEKS_MOM && ratio[i - WEEKS_MOM] != null ? v - (ratio[i - WEEKS_MOM] as number) : null
  );
  const mom = roc.map((_, i) => {
    const z = zscoreLast(roc, i, WEEKS_Z);
    return z == null ? null : 100 + z;
  });

  const last = days.length - 1;
  const prev = last - TAIL;
  const [r1, m1, r0, m0] = [ratio[last], mom[last], ratio[prev], mom[prev]];
  if (r1 == null || m1 == null || r0 == null || m0 == null) return null;

  return {
    ticker,
    benchmark,
    ratio: r1,
    momentum: m1,
    quadrant: quadrant(r1, m1),
    from: quadrant(r0, m0),
    dRatio: (r1 - r0) / TAIL,
    dMomentum: (m1 - m0) / TAIL,
    asOf: new Date(days[last] * 86400 * 1000).toISOString().slice(0, 10),
  };
}

/** RRG points for `tickers` against `benchmark`. Failed fetches are omitted. */
export async function fetchRrg(tickers: string[], benchmark: string): Promise<RrgPoint[]> {
  const uniq = [...new Set(tickers.filter((t) => t !== benchmark))];
  const [bench, ...series] = await Promise.all([
    fetchWeeklyCloses(benchmark),
    ...uniq.map(fetchWeeklyCloses),
  ]);
  return uniq
    .map((t, i) => computeRrg(t, benchmark, series[i], bench))
    .filter((p): p is RrgPoint => p !== null);
}

/** Heading in plain words: which way the tail is travelling. */
export function heading(p: RrgPoint): string {
  const h = p.dRatio >= 0 ? "right" : "left";
  const v = p.dMomentum >= 0 ? "up" : "down";
  return `${v}-${h}`;
}

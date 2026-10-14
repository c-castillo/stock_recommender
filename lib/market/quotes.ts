/**
 * Live quote fetching, shared by the analysis pipeline and the MCP server.
 *
 * Yahoo's v7 /quote endpoint now requires a crumb+cookie and returns 401
 * Unauthorized. The v8 /chart endpoint is still anonymous-accessible and
 * exposes the live price at result[0].meta.regularMarketPrice. It's one
 * request per symbol, so callers fan out in parallel.
 */

/** Where New York's clock stood when the quote was read. */
export type MarketPhase = "pre-market" | "open" | "after-hours" | "closed";

export interface Quote {
  /** Last price of the regular session: live while it is open, otherwise the
   *  official close. This is the number stops and entries are measured on. */
  price: number;
  /** New York date of the session `price` belongs to. */
  sessionDate: string;
  phase: MarketPhase;
  /** Last pre-market or after-hours trade, when there is one newer than
   *  `price`. Thin and jumpy: it says where the open may be, nothing more. */
  extended: number | null;
  previousClose: number | null;
}

interface Period {
  start: number;
  end: number;
}

/** Pure, so the phase logic can be tested without the network. */
export function readQuote(result: unknown, nowSec: number): Quote | null {
  const r = result as {
    meta?: Record<string, unknown>;
    timestamp?: number[];
    indicators?: { quote?: { close?: (number | null)[] }[] };
  } | null;
  const meta = r?.meta;
  const price = meta?.regularMarketPrice;
  if (!meta || typeof price !== "number") return null;

  const periods = meta.currentTradingPeriod as { pre?: Period; regular?: Period; post?: Period } | undefined;
  const pre = periods?.pre;
  const regular = periods?.regular;
  const post = periods?.post;
  let phase: MarketPhase = "closed";
  if (regular && nowSec >= regular.start && nowSec < regular.end) phase = "open";
  else if (pre && nowSec >= pre.start && nowSec < pre.end) phase = "pre-market";
  else if (post && nowSec >= post.start && nowSec < post.end) phase = "after-hours";

  const at = typeof meta.regularMarketTime === "number" ? meta.regularMarketTime : nowSec;
  const sessionDate = new Date(at * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // The newest bar outside the regular session, if it is newer than `price`.
  let extended: number | null = null;
  if (phase !== "open") {
    const ts = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    for (let i = ts.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (c == null) continue;
      if (ts[i] > at) extended = c;
      break;
    }
  }

  const prev = meta.chartPreviousClose ?? meta.previousClose;
  return { price, sessionDate, phase, extended, previousClose: typeof prev === "number" ? prev : null };
}

export async function fetchQuotes(tickers: string[]): Promise<Record<string, Quote | null>> {
  const quotes: Record<string, Quote | null> = {};
  for (const t of tickers) quotes[t] = null;

  await Promise.all(
    tickers.map(async (t) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=5m&range=1d&includePrePost=true`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;
        const data = await res.json();
        const result = data?.chart?.result?.[0];
        const q = readQuote(result, Date.now() / 1000);
        if (q) quotes[(result.meta.symbol ?? t).toUpperCase()] = q;
      } catch {
        /* leave this ticker null on per-symbol failure */
      }
    })
  );

  return quotes;
}

/** The regular-session price of each ticker: live, or the last close. */
export async function fetchCurrentPrices(
  tickers: string[]
): Promise<Record<string, number | null>> {
  const prices: Record<string, number | null> = {};
  for (const t of tickers) prices[t] = null;
  if (tickers.length === 0) return prices;
  for (const [t, q] of Object.entries(await fetchQuotes(tickers))) prices[t] = q?.price ?? null;
  return prices;
}

/** "close of 13-10", "live", "close of 13-10, pre-market $955.10 (+0.2%)". */
export function describeQuote(q: Quote): string {
  const day = `${q.sessionDate.slice(8, 10)}-${q.sessionDate.slice(5, 7)}`;
  if (q.phase === "open") return "live, session open";
  const ext =
    q.extended != null
      ? `, ${q.phase === "pre-market" ? "pre-market" : "after-hours"} $${q.extended.toFixed(2)} (${
          q.extended >= q.price ? "+" : ""
        }${(100 * (q.extended / q.price - 1)).toFixed(1)}%)`
      : "";
  return `close of ${day}${ext}`;
}

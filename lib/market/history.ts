/**
 * Daily closes, and what a trailing stop needs from them: the highest close
 * since the position was opened.
 *
 * A trailing percentage is measured from that high. Without it the report
 * could only print the level of the day it was written, which is a floor: the
 * real level rises with every new high and never comes back down.
 */

import type { BrokerOrder } from "@/lib/zesty/orders";

export interface DailyClose {
  /** New York session date, YYYY-MM-DD. */
  date: string;
  close: number;
}

export async function fetchDailyCloses(ticker: string, range = "1y"): Promise<DailyClose[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const r = (await res.json())?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    const out: DailyClose[] = [];
    const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    ts.forEach((t, i) => {
      const c = closes[i];
      if (c != null) out.push({ date: day(t), close: c });
    });
    // Yahoo sometimes leaves the newest daily bar empty for hours after the
    // close while the quote beside it has the price.
    const meta = r?.meta;
    if (typeof meta?.regularMarketTime === "number" && typeof meta?.regularMarketPrice === "number") {
      const last = day(meta.regularMarketTime);
      if (!out.some((c) => c.date === last)) out.push({ date: last, close: meta.regularMarketPrice });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The day the shares held today started to be held: the buy that took the
 * position up from zero. Walks the broker's fills backwards from today's
 * share count. Null when the history ends before the position does.
 */
export function openedOn(ticker: string, shares: number, closed: BrokerOrder[]): string | null {
  const fills = closed
    .filter((o) => o.ticker === ticker && o.filledQty > 0)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let held = shares;
  for (const o of fills) {
    held += o.side === "buy" ? -o.filledQty : o.filledQty;
    if (o.side === "buy" && held <= 1e-6) return o.createdAt.slice(0, 10);
  }
  return null;
}

export interface TrailingHigh {
  /** First day counted, and whether it is the real entry or only the oldest day known. */
  since: string;
  exact: boolean;
  high: number;
  highDate: string;
}

/**
 * `since` is the entry date. When the broker's history does not reach it,
 * pass the oldest date the history covers as `floor`: the high since then is
 * a lower bound of the real one, and the result says so with `exact: false`.
 */
export function highestCloseSince(closes: DailyClose[], since: string | null, floor?: string | null): TrailingHigh | null {
  const from = since ?? floor ?? null;
  const window = from ? closes.filter((c) => c.date >= from) : closes;
  if (window.length === 0) return null;
  const top = window.reduce((a, b) => (b.close > a.close ? b : a));
  return { since: from ?? window[0].date, exact: since != null, high: top.close, highDate: top.date };
}

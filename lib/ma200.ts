/**
 * Shared MA200 slope computation used by both the API route and the AI system prompt.
 *
 * Slope = % change in the 200-day MA over the last 20 trading days.
 * Positive → upward slope (demand > supply).
 * Negative → downward slope (supply > demand).
 */
export async function fetchMa200Slopes(
  tickers: string[]
): Promise<Record<string, number | null>> {
  const slopes: Record<string, number | null> = {};
  for (const t of tickers) slopes[t] = null;

  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const url =
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
          `?interval=1d&range=14mo`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;

        const data = await res.json();
        const closes: (number | null)[] =
          data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];

        const valid = closes.filter((c): c is number => c != null && isFinite(c));

        // Need ≥220 points: 200 for today's MA + 20 offset for the prior MA
        if (valid.length < 220) return;

        const ma200Today = avg(valid.slice(valid.length - 200));
        const ma200_20dAgo = avg(valid.slice(valid.length - 220, valid.length - 20));

        slopes[ticker] = ((ma200Today - ma200_20dAgo) / ma200_20dAgo) * 100;
      } catch {
        /* leave null on network/parse failure */
      }
    })
  );

  return slopes;
}

function avg(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

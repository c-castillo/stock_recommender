/**
 * Live quote fetching, shared by the analysis pipeline and the MCP server.
 *
 * Yahoo's v7 /quote endpoint now requires a crumb+cookie and returns 401
 * Unauthorized. The v8 /chart endpoint is still anonymous-accessible and
 * exposes the live price at result[0].meta.regularMarketPrice. It's one
 * request per symbol, so callers fan out in parallel.
 */

export async function fetchCurrentPrices(
  tickers: string[]
): Promise<Record<string, number | null>> {
  const prices: Record<string, number | null> = {};
  for (const t of tickers) prices[t] = null;
  if (tickers.length === 0) return prices;

  await Promise.all(
    tickers.map(async (t) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;
        const data = await res.json();
        const meta = data?.chart?.result?.[0]?.meta;
        const price = meta?.regularMarketPrice;
        if (typeof price === "number") {
          prices[(meta.symbol ?? t).toUpperCase()] = price;
        }
      } catch {
        /* leave this ticker null on per-symbol failure */
      }
    })
  );

  return prices;
}

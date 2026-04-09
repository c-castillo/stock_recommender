export const dynamic = "force-dynamic";

/**
 * GET /api/prices?tickers=AAPL,TSLA,NVDA
 *
 * Returns current prices fetched from Yahoo Finance's public quote API.
 * Returns { prices: { [ticker]: number | null } }
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("tickers") ?? "";
  const tickers = raw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  if (tickers.length === 0) {
    return Response.json({ prices: {} });
  }

  const prices: Record<string, number | null> = {};
  for (const t of tickers) prices[t] = null;

  try {
    const symbols = tickers.join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      const data = await res.json();
      const results: any[] = data?.quoteResponse?.result ?? [];
      for (const q of results) {
        const sym = (q.symbol as string)?.toUpperCase();
        if (sym && typeof q.regularMarketPrice === "number") {
          prices[sym] = q.regularMarketPrice;
        }
      }
    }
  } catch {
    /* return nulls on network failure */
  }

  return Response.json({ prices });
}

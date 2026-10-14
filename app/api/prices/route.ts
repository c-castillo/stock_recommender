import { fetchQuotes } from "@/lib/market/quotes";

export const dynamic = "force-dynamic";

/**
 * GET /api/prices?tickers=AAPL,TSLA,NVDA
 *
 * Returns { prices: { [ticker]: number | null }, quotes: { [ticker]: Quote | null } }.
 * `prices` is the regular-session price (live, or the last close); `quotes`
 * adds which session it belongs to and any pre-market or after-hours trade.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("tickers") ?? "";
  const tickers = raw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  if (tickers.length === 0) {
    return Response.json({ prices: {}, quotes: {} });
  }

  const quotes = await fetchQuotes(tickers);
  const prices: Record<string, number | null> = {};
  for (const t of tickers) prices[t] = quotes[t]?.price ?? null;

  return Response.json({ prices, quotes });
}

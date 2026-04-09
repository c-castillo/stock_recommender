export const dynamic = "force-dynamic";

import { fetchMa200Slopes } from "@/lib/ma200";

/**
 * GET /api/ma200?tickers=AAPL,TSLA,NVDA
 * Returns: { slopes: { [ticker]: number | null } }
 * Slope = % change in the 200-day MA over the last 20 trading days.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("tickers") ?? "";
  const tickers = raw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  if (tickers.length === 0) return Response.json({ slopes: {} });

  const slopes = await fetchMa200Slopes(tickers);
  return Response.json({ slopes });
}

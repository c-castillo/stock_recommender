import {
  listPortfolio,
  upsertPosition,
  deletePosition,
  getCashBalance,
  getBuyingPower,
  getBrokerOrders,
} from "@/lib/whatsapp/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    positions: listPortfolio(),
    cash_balance: getCashBalance(),
    buying_power: getBuyingPower(),
    orders: recentOrders(),
  });
}

/** Open orders and the closed ones of the last 180 days: the full history is
 *  on record for entry dates, but no caller of this route needs all of it. */
function recentOrders() {
  const orders = getBrokerOrders();
  if (!orders) return null;
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
  return { ...orders, closed: orders.closed.filter((o) => o.createdAt >= since) };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.ticker || typeof body.shares !== "number" || body.shares <= 0) {
    return Response.json({ error: "ticker y shares requeridos" }, { status: 400 });
  }
  upsertPosition(body.ticker, body.shares, body.avg_cost ?? null);
  return Response.json({ positions: listPortfolio() });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker");
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });
  deletePosition(ticker);
  return Response.json({ positions: listPortfolio() });
}

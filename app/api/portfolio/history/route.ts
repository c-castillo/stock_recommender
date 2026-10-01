import { getPortfolioHistory, upsertPortfolioSnapshot } from "@/lib/whatsapp/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ history: getPortfolioHistory(90) });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (
    !body ||
    typeof body.total_value !== "number" ||
    typeof body.market_value !== "number" ||
    typeof body.cash_balance !== "number"
  ) {
    return Response.json({ error: "total_value, market_value, cash_balance requeridos" }, { status: 400 });
  }
  // Local date: toISOString() is UTC, which files an evening snapshot in Chile
  // under tomorrow.
  const date: string = body.date ?? new Date().toLocaleDateString("en-CA");
  upsertPortfolioSnapshot({ date, total_value: body.total_value, market_value: body.market_value, cash_balance: body.cash_balance });
  return Response.json({ ok: true, date });
}

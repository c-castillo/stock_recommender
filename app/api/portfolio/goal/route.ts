import { getPortfolioGoal, setPortfolioGoal } from "@/lib/whatsapp/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ goal: getPortfolioGoal() });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.amount !== "number" || body.amount <= 0 || !body.deadline) {
    return Response.json({ error: "amount y deadline requeridos" }, { status: 400 });
  }
  setPortfolioGoal({ amount: body.amount, deadline: body.deadline });
  return Response.json({ goal: getPortfolioGoal() });
}

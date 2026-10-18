import { getBrokerOrders, getTradeOrigins, listPortfolio, setTradeOrigin } from "@/lib/whatsapp/db";
import { buildJournal, loadReportAsks } from "@/lib/market/trade-journal";
import { legFillOrders } from "@/lib/zesty/legs";

export const dynamic = "force-dynamic";

/** Every trade from the broker's filled orders, newest first. */
export async function GET() {
  const orders = getBrokerOrders();
  const prices: Record<string, number> = {};
  for (const p of listPortfolio()) if (p.current_price != null) prices[p.ticker] = p.current_price;
  const closed = orders?.closed ?? [];
  // A filled oto stop closes its trade but is listed only as the parent's leg.
  const journal = buildJournal([...closed, ...legFillOrders(closed)], loadReportAsks(), getTradeOrigins(), prices);
  return Response.json({ ...journal, syncedAt: orders?.at ?? null });
}

/** Set a trade's origin by hand ({id, origin: "agent" | "user" | null}); null
 *  goes back to the match against the reports. */
export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.id || !["agent", "user", null].includes(body.origin)) {
    return Response.json({ error: "id y origin (agent | user | null) requeridos" }, { status: 400 });
  }
  setTradeOrigin(String(body.id), body.origin);
  return Response.json({ ok: true });
}

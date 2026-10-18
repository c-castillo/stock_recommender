import { fetchZestyData } from "@/lib/zesty/portfolio";
import { isWorking, parseOrders } from "@/lib/zesty/orders";
import {
  upsertPosition,
  setCashBalance,
  setBuyingPower,
  getBuyingPower,
  clearPortfolio,
  listPortfolio,
  getCashBalance,
  upsertPortfolioSnapshot,
  getPerformanceAnchor,
  setBrokerOrders,
  getBrokerOrders,
} from "@/lib/whatsapp/db";

export const dynamic = "force-dynamic";

export async function POST() {
  let raw: unknown[];
  let cashBalance: number | null = null;
  let buyingPower: number | null = null;
  let openOrders: unknown[] | null = null;
  let closedOrders: unknown[] | null = null;
  try {
    const data = await fetchZestyData(new Set((getBrokerOrders()?.closed ?? []).map((o) => o.id)));
    raw = data.positions;
    cashBalance = data.cashBalance;
    buyingPower = data.buyingPower;
    openOrders = data.openOrders;
    closedOrders = data.closedOrders;
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Error al conectar con Zesty" },
      { status: 502 }
    );
  }

  const positions = parsePositions(raw);

  if (positions.length === 0) {
    return Response.json(
      { error: "No se encontraron posiciones en la respuesta de Zesty" },
      { status: 422 }
    );
  }

  clearPortfolio();

  for (const p of positions) {
    upsertPosition(
      p.ticker,
      p.shares,
      p.avg_cost,
      p.current_price,
      p.market_value,
      p.unrealized_pl,
      p.unrealized_pl_pc
    );
  }

  if (cashBalance !== null) setCashBalance(cashBalance);
  if (cashBalance !== null || buyingPower !== null) setBuyingPower(buyingPower);

  // Keep the last good read of each list: a failed request must not make the
  // run believe that nothing rests at the broker.
  const before = getBrokerOrders();
  // The pending list keeps a filled oto/bracket parent for as long as its stop
  // leg rests, so it is split by state: the leg stays open, the fill is closed.
  const pending = openOrders ? parseOrders(openOrders) : null;
  const orders = {
    at: Math.floor(Date.now() / 1000),
    open: pending ? pending.filter(isWorking) : (before?.open ?? []),
    // New pages first, so a re-read order replaces its older copy.
    closed:
      closedOrders || pending
        ? dedupe([
            ...(pending ?? []).filter((o) => !isWorking(o)),
            ...parseOrders(closedOrders),
            ...(before?.closed ?? []),
          ])
        : (before?.closed ?? []),
  };
  if (openOrders || closedOrders) setBrokerOrders(orders);

  // Record today's total here rather than leaving it to the dashboard page:
  // that only wrote a row while a browser tab was open, so days synced from
  // /daily-run left gaps in the history the drawdown is measured against.
  const cash = cashBalance ?? getCashBalance() ?? 0;
  const marketValue = positions.reduce((sum, p) => sum + (p.market_value ?? 0), 0);
  if (marketValue > 0) {
    upsertPortfolioSnapshot({
      date: new Date().toLocaleDateString("en-CA"),
      total_value: marketValue + cash,
      market_value: marketValue,
      cash_balance: cash,
    });
  }

  // The performance block is only as good as the hand-maintained list of
  // deposits and withdrawals; expose how fresh it is so a caller can compare
  // it with the broker's own movements.
  const anchor = getPerformanceAnchor();
  const lastFlow = anchor?.flows.reduce<string | null>(
    (latest, f) => (latest == null || f.date > latest ? f.date : latest),
    null
  );

  return Response.json({
    imported: positions.length,
    cash_balance: cashBalance ?? getCashBalance(),
    buying_power: getBuyingPower(),
    positions: listPortfolio(),
    orders_read: { open: openOrders !== null, closed: closedOrders !== null },
    open_orders: orders.open,
    closed_orders: orders.closed.slice(0, 40),
    closed_orders_on_record: orders.closed.length,
    performance_anchor: anchor
      ? { asOf: anchor.asOf, flows: anchor.flows.length, lastFlowDate: lastFlow ?? null }
      : null,
  });
}

/** Pages of the history can overlap; keep each order once, newest first. */
function dedupe<T extends { id: string; createdAt: string }>(orders: T[]): T[] {
  const seen = new Map<string, T>();
  for (const o of orders) if (!seen.has(o.id)) seen.set(o.id, o);
  return [...seen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Parser (same logic as /api/portfolio/sync) ────────────────────────────────

interface ParsedPosition {
  ticker: string;
  shares: number;
  avg_cost: number | null;
  current_price: number | null;
  market_value: number | null;
  unrealized_pl: number | null;
  unrealized_pl_pc: number | null;
}

function parsePositions(data: unknown[]): ParsedPosition[] {
  const results: ParsedPosition[] = [];

  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;

    const asset =
      typeof obj.asset === "object" && obj.asset !== null
        ? (obj.asset as Record<string, unknown>)
        : null;

    const ticker = str(obj.symbol ?? obj.ticker ?? obj.stock ?? obj.code ?? asset?.symbol);
    const shares = num(obj.qty ?? obj.shares ?? obj.quantity ?? obj.units ?? obj.amount);
    const avg_cost = num(obj.avgPrice ?? obj.avg_cost ?? obj.avgCost ?? obj.average_cost ?? obj.averagePrice ?? obj.avg_price ?? obj.costBasis ?? obj.cost_basis);
    const current_price = num(asset?.price ?? obj.current_price ?? obj.currentPrice ?? obj.price ?? obj.last_price ?? obj.lastPrice ?? obj.market_price ?? obj.marketPrice ?? obj.close);
    const market_value = num(obj.marketValue ?? obj.market_value ?? obj.totalValue ?? obj.total_value);
    const unrealized_pl = num(obj.unrealizedPl ?? obj.unrealized_pl ?? obj.unrealizedPnl ?? obj.pnl);
    const unrealized_pl_pc = num(obj.unrealizedPlPc ?? obj.unrealized_pl_pc ?? obj.unrealizedPnlPc ?? obj.pnlPc);

    if (!ticker || shares === null || shares <= 0) continue;
    results.push({
      ticker: ticker.toUpperCase().trim(),
      shares,
      avg_cost,
      current_price,
      market_value,
      unrealized_pl,
      unrealized_pl_pc,
    });
  }

  return results;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

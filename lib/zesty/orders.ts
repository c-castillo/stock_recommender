/**
 * The broker's orders in one shape, whatever the endpoint that returned them.
 *
 * The run needs two things from them: what rests at the broker (so a stop the
 * report asks for is compared with the one already there) and what filled, at
 * what price (so "was the order taken" is read from the broker, not guessed
 * from two portfolio snapshots).
 */

export type OrderState = "open" | "filled" | "partial" | "canceled" | "expired" | "rejected" | "other";

export interface BrokerOrder {
  id: string;
  ticker: string;
  side: "buy" | "sell";
  /** limit, market, stop, stop_limit or trailing_stop. */
  type: string;
  qty: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  trailPercent: number | null;
  filledQty: number;
  filledAvgPrice: number | null;
  state: OrderState;
  /** The broker's own word for the status, as received. */
  status: string;
  timeInForce: string | null;
  createdAt: string;
}

export interface BrokerOrders {
  /** When the broker was read, in seconds. */
  at: number;
  open: BrokerOrder[];
  closed: BrokerOrder[];
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

/** Zesty answers in Spanish ("Completada", "Pendiente", "Cancelada"…). */
export function orderState(status: string, filledQty: number, qty: number | null): OrderState {
  const s = status.toLowerCase();
  if (/complet|ejecutad|filled/.test(s)) return "filled";
  if (/parcial|partial/.test(s)) return "partial";
  if (/cancel/.test(s)) return filledQty > 0 ? "partial" : "canceled";
  if (/expir|vencid/.test(s)) return filledQty > 0 ? "partial" : "expired";
  if (/rechaz|reject/.test(s)) return "rejected";
  if (/pend|new|accept|abiert|open/.test(s)) return filledQty > 0 && qty != null && filledQty < qty ? "partial" : "open";
  return "other";
}

export function parseOrders(raw: unknown[] | null): BrokerOrder[] {
  const out: BrokerOrder[] = [];
  for (const item of raw ?? []) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const ticker = String(o.symbol ?? "").toUpperCase().trim();
    const side = String(o.side ?? "").toLowerCase();
    if (!ticker || (side !== "buy" && side !== "sell")) continue;
    const qty = num(o.qty);
    const filledQty = num(o.filledQty) ?? 0;
    const status = String(o.status ?? "");
    out.push({
      id: String(o.orderId ?? ""),
      ticker,
      side,
      type: String(o.type ?? ""),
      qty,
      limitPrice: num(o.limitPrice),
      stopPrice: num(o.stopPrice),
      trailPercent: num(o.trailPercent),
      filledQty,
      filledAvgPrice: num(o.filledAvgPrice),
      state: orderState(status, filledQty, qty),
      status,
      timeInForce: typeof o.timeInForce === "string" ? o.timeInForce : null,
      createdAt: String(o.createdAt ?? ""),
    });
  }
  return out;
}

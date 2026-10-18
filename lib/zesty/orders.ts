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

function parseOne(o: Record<string, unknown>, ticker: string, createdAt: string): BrokerOrder | null {
  const side = String(o.side ?? "").toLowerCase();
  if (!ticker || (side !== "buy" && side !== "sell")) return null;
  const qty = num(o.qty);
  const status = String(o.status ?? "");
  let filledQty = num(o.filledQty) ?? 0;
  let filledAvgPrice = num(o.filledAvgPrice);
  // A leg that has not traded still carries filledAvgPrice = its stop price
  // (and no filledQty), so trust a price only on a leg that says it filled.
  if (o.filledQty === undefined) {
    const filled = /complet|ejecutad|filled/i.test(status);
    filledQty = filled ? (qty ?? 0) : 0;
    if (!filled) filledAvgPrice = null;
  }
  return {
    id: String(o.orderId ?? ""),
    ticker,
    side,
    type: String(o.type ?? ""),
    qty,
    limitPrice: num(o.limitPrice),
    stopPrice: num(o.stopPrice),
    trailPercent: num(o.trailPercent),
    filledQty,
    filledAvgPrice,
    state: orderState(status, filledQty, qty),
    status,
    timeInForce: typeof o.timeInForce === "string" ? o.timeInForce : null,
    createdAt,
  };
}

/**
 * One row per order, and one per leg of an oto/oco/bracket order: the stop a
 * buy carries is a resting order of its own once the buy fills, and Zesty
 * lists it only inside the parent's `legs`.
 */
export function parseOrders(raw: unknown[] | null): BrokerOrder[] {
  const out: BrokerOrder[] = [];
  for (const item of raw ?? []) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const ticker = String(o.symbol ?? "").toUpperCase().trim();
    const createdAt = String(o.createdAt ?? "");
    const parent = parseOne(o, ticker, createdAt);
    if (parent) out.push(parent);
    for (const leg of Array.isArray(o.legs) ? o.legs : []) {
      if (typeof leg !== "object" || leg === null) continue;
      const row = parseOne(leg as Record<string, unknown>, ticker, createdAt);
      if (row) out.push(row);
    }
  }
  return out;
}

/** Still working at the broker: what rests, as opposed to what ended. */
export function isWorking(o: BrokerOrder): boolean {
  // "partial" is also a cancelled or expired order that had filled in part.
  return o.state === "open" || (o.state === "partial" && !/cancel|expir|vencid/i.test(o.status));
}

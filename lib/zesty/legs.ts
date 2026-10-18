/**
 * The exit legs of the oto/bracket orders placed through the Zesty connector,
 * by parent order id. Zesty's web API never lists a leg, so the sync can only
 * see one whose id was written here when its order was confirmed (the
 * confirmation returns `legIds`). Record them with:
 *
 *   pnpm exec tsx scripts/record-zesty-leg.ts <parentId> <legId> <side> <type> <qty> <stopPrice>
 *
 * A leg that fills closes the position without the parent ever showing a
 * sale, so its fill is kept here too: the sync writes it when it reads the
 * leg by id, and the connector's `get_order_detail` can supply it with
 *
 *   pnpm exec tsx scripts/record-zesty-leg.ts fill <legId> <qty> <avgPrice> <filledAt>
 */
import fs from "node:fs";
import path from "node:path";
import type { BrokerOrder } from "@/lib/zesty/orders";

export interface KnownLeg {
  legId: string;
  side: "buy" | "sell";
  type: string;
  qty: number;
  stopPrice: number | null;
  limitPrice?: number | null;
  /** Set once the leg has filled. */
  filledQty?: number;
  filledAvgPrice?: number;
  /** ISO time of the fill (the order's `fill` event), or of the read that found it. */
  filledAt?: string;
  /** True once the leg can no longer fill (filled, cancelled, expired). */
  done?: boolean;
}

export const LEGS_FILE = path.join(process.cwd(), ".whatsapp", "zesty-legs.json");

export function readKnownLegs(): Record<string, KnownLeg[]> {
  try {
    return JSON.parse(fs.readFileSync(LEGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeKnownLegs(all: Record<string, KnownLeg[]>): void {
  fs.writeFileSync(LEGS_FILE, JSON.stringify(all, null, 1) + "\n");
}

export function recordKnownLeg(parentId: string, leg: KnownLeg): void {
  const all = readKnownLegs();
  all[parentId] = [...(all[parentId] ?? []).filter((l) => l.legId !== leg.legId), leg];
  writeKnownLegs(all);
}

/** Mark a leg filled or ended. False when the leg id is not on record. */
export function recordLegOutcome(
  legId: string,
  outcome: { filledQty: number; filledAvgPrice: number | null; filledAt: string } | { ended: true }
): boolean {
  const all = readKnownLegs();
  for (const legs of Object.values(all)) {
    const leg = legs.find((l) => l.legId === legId);
    if (!leg) continue;
    if ("ended" in outcome) leg.done = true;
    else Object.assign(leg, { ...outcome, filledAvgPrice: outcome.filledAvgPrice ?? undefined, done: true });
    writeKnownLegs(all);
    return true;
  }
  return false;
}

/**
 * The filled legs as closed orders, so a trade they closed shows its sale.
 * The ticker comes from the parent, found among `orders`.
 */
export function legFillOrders(orders: BrokerOrder[], known = readKnownLegs()): BrokerOrder[] {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const out: BrokerOrder[] = [];
  for (const [parentId, legs] of Object.entries(known)) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    for (const leg of legs) {
      if (!leg.filledQty || leg.filledAvgPrice == null || byId.has(leg.legId)) continue;
      out.push({
        id: leg.legId, ticker: parent.ticker, side: leg.side, type: leg.type, qty: leg.qty,
        limitPrice: leg.limitPrice ?? null, stopPrice: leg.stopPrice, trailPercent: null,
        filledQty: leg.filledQty, filledAvgPrice: leg.filledAvgPrice, state: "filled",
        status: "Completada", timeInForce: "gtc", createdAt: leg.filledAt ?? parent.createdAt,
      });
    }
  }
  return out;
}

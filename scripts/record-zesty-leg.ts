/**
 * Record an oto/bracket exit leg so the Zesty sync can see it rest.
 *   pnpm exec tsx scripts/record-zesty-leg.ts <parentId> <legId> <side> <type> <qty> <stopPrice>
 * Or record that a known leg filled (from the connector's get_order_detail on
 * the leg: filledQty, filledAvgPrice and the time of its `fill` event):
 *   pnpm exec tsx scripts/record-zesty-leg.ts fill <legId> <qty> <avgPrice> <filledAt>
 */
import { recordKnownLeg, recordLegOutcome } from "../lib/zesty/legs";

const args = process.argv.slice(2);
if (args[0] === "fill") {
  const [, legId, qty, price, at] = args;
  if (!legId || !Number(qty) || !Number(price) || !at || isNaN(Date.parse(at))) {
    console.error("usage: record-zesty-leg.ts fill <legId> <qty> <avgPrice> <filledAt ISO>");
    process.exit(1);
  }
  if (!recordLegOutcome(legId, { filledQty: Number(qty), filledAvgPrice: Number(price), filledAt: at })) {
    console.error(`leg ${legId} is not on record: record it first`);
    process.exit(1);
  }
  console.log(`recorded fill of leg ${legId}: ${qty} @ ${price} at ${at}`);
  process.exit(0);
}

const [parentId, legId, side, type, qty, stopPrice] = args;
if (!parentId || !legId || (side !== "buy" && side !== "sell") || !type || !qty) {
  console.error("usage: record-zesty-leg.ts <parentId> <legId> <buy|sell> <type> <qty> <stopPrice>");
  process.exit(1);
}
recordKnownLeg(parentId, {
  legId,
  side,
  type,
  qty: Number(qty),
  stopPrice: stopPrice ? Number(stopPrice) : null,
});
console.log(`recorded ${type} ${side} ${qty} @ ${stopPrice ?? "—"} (leg ${legId} of ${parentId})`);

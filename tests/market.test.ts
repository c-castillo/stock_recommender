/**
 * The money maths and the parsers a silent bug would cost most in.
 * Run with `pnpm test`. No network and no database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BREAK_EVEN_WEEKS,
  CASH_APR,
  COMMISSION_PC,
  RISK_PER_POSITION,
  ROUND_TRIP_PC,
  cashReturn,
  sharesAtRisk,
} from "../lib/market/costs";
import { highestCloseSince, openedOn } from "../lib/market/history";
import { describeQuote, readQuote } from "../lib/market/quotes";
import { HEDGE_LEVERAGE } from "../lib/market/sectors";
import { orderState, parseOrders, type BrokerOrder } from "../lib/zesty/orders";

test("costs: a round trip is two commissions and cash compounds by the day", () => {
  assert.equal(ROUND_TRIP_PC, 2 * COMMISSION_PC);
  assert.ok(Math.abs(cashReturn(365) - CASH_APR) < 1e-12);
  assert.equal(cashReturn(0), 0);
  assert.equal(cashReturn(-5), 0);
  assert.ok(cashReturn(90) > 0.008 && cashReturn(90) < 0.009);
  // 0.60% of commissions against 3.5% a year is about nine weeks of interest.
  assert.ok(BREAK_EVEN_WEEKS > 8.5 && BREAK_EVEN_WEEKS < 9.5);
});

test("costs: the risk budget sizes a buy from its stop", () => {
  // $34,769 × 0.75% = $260.77; $20.73 a share at risk → 12 shares.
  assert.equal(sharesAtRisk(34769.24, 268.73, 248), 12);
  assert.equal(sharesAtRisk(34769.24, 100, 100), 0);
  assert.equal(sharesAtRisk(34769.24, 100, 110), 0);
  assert.ok(sharesAtRisk(34769.24, 268.73, 248) * (268.73 - 248) <= 34769.24 * RISK_PER_POSITION);
});

test("costs: the Python scripts and the playbook quote the same figures", () => {
  const py = readFileSync("scripts/marketdata.py", "utf8");
  const grab = (name: string) => Number(new RegExp(`^${name} = ([\\d.]+)`, "m").exec(py)?.[1]);
  assert.equal(grab("COMMISSION_PC"), COMMISSION_PC);
  assert.equal(grab("CASH_APR"), CASH_APR);
  assert.equal(grab("RISK_PER_POSITION"), RISK_PER_POSITION);
  const playbook = readFileSync("lib/ai/playbook.ts", "utf8");
  assert.ok(playbook.includes(`${(COMMISSION_PC * 100).toFixed(2)}%`));
  assert.ok(playbook.includes(`${(CASH_APR * 100).toFixed(1)}%`));
  assert.ok(playbook.includes(`${(RISK_PER_POSITION * 100).toFixed(2)}%`));
});

test("hedges: every inverse ETF has a leverage, so none counts as a long", () => {
  for (const t of ["SSG", "QID", "SOXS", "PSQ", "SQQQ", "SH", "SDS"]) assert.ok(HEDGE_LEVERAGE[t] >= 1, t);
  assert.equal(HEDGE_LEVERAGE.MU, undefined);
});

// Tuesday 13-10-2026 in New York: pre 04:00, open 09:30, close 16:00, post until 20:00.
const PERIODS = {
  pre: { start: 1791878400, end: 1791898200 },
  regular: { start: 1791898200, end: 1791921600 },
  post: { start: 1791921600, end: 1791936000 },
};
const chart = (bars: [number, number | null][]) => ({
  meta: { regularMarketPrice: 953.19, regularMarketTime: 1791921601, chartPreviousClose: 989.04, currentTradingPeriod: PERIODS },
  timestamp: bars.map((b) => b[0]),
  indicators: { quote: [{ close: bars.map((b) => b[1]) }] },
});

test("quotes: a close stays a close, and an after-hours print never replaces it", () => {
  const q = readQuote(chart([[1791921000, 953.0], [1791930000, 956.2]]), 1791931000)!;
  assert.equal(q.price, 953.19);
  assert.equal(q.phase, "after-hours");
  assert.equal(q.extended, 956.2);
  assert.equal(q.sessionDate, "2026-10-13");
  assert.match(describeQuote(q), /^close of 13-10, after-hours \$956\.20 \(\+0\.3%\)$/);
});

test("quotes: an open session is live and has no extended price", () => {
  const live = { ...chart([[1791900000, 950]]), meta: { ...chart([]).meta, regularMarketTime: 1791900000 } };
  const q = readQuote(live, 1791900100)!;
  assert.equal(q.phase, "open");
  assert.equal(q.extended, null);
  assert.equal(describeQuote(q), "live, session open");
});

test("quotes: overnight is closed, and a missing price is no quote", () => {
  assert.equal(readQuote(chart([[1791921000, 953.0]]), 1791940000)!.phase, "closed");
  assert.equal(readQuote({ meta: {} }, 0), null);
  assert.equal(readQuote(null, 0), null);
});

const order = (o: Partial<BrokerOrder>): BrokerOrder => ({
  id: "x", ticker: "EBAY", side: "buy", type: "limit", qty: 5, limitPrice: 114.5, stopPrice: null, trailPercent: null,
  filledQty: 5, filledAvgPrice: 114.5, state: "filled", status: "Completada", timeInForce: null,
  createdAt: "2026-10-12T22:32:37Z", ...o,
});

test("history: the entry date is the buy that took the position up from zero", () => {
  const fills = [
    order({ createdAt: "2026-09-01T14:00:00Z", qty: 10, filledQty: 10 }),
    order({ createdAt: "2026-09-20T14:00:00Z", side: "sell", qty: 10, filledQty: 10 }),
    order({ createdAt: "2026-10-05T14:00:00Z", qty: 5, filledQty: 5 }),
    order({ createdAt: "2026-10-12T14:00:00Z", qty: 5, filledQty: 5 }),
  ];
  assert.equal(openedOn("EBAY", 10, fills), "2026-10-05");
  // More shares than the history explains: the entry is older than the record.
  assert.equal(openedOn("EBAY", 40, fills), null);
  assert.equal(openedOn("MU", 5, fills), null);
});

test("history: the trailing high counts closes from the entry on", () => {
  const closes = [
    { date: "2026-09-30", close: 400 },
    { date: "2026-10-05", close: 120 },
    { date: "2026-10-07", close: 131 },
    { date: "2026-10-12", close: 116 },
  ];
  assert.deepEqual(highestCloseSince(closes, "2026-10-05"), { since: "2026-10-05", exact: true, high: 131, highDate: "2026-10-07" });
  // Entry older than the record: counted from where the record starts, and marked as a lower bound.
  assert.deepEqual(highestCloseSince(closes, null, "2026-10-06"), { since: "2026-10-06", exact: false, high: 131, highDate: "2026-10-07" });
  assert.equal(highestCloseSince(closes, null)?.high, 400);
  assert.equal(highestCloseSince([], "2026-10-05"), null);
});

test("broker orders: Zesty's Spanish statuses map to one state each", () => {
  assert.equal(orderState("Completada", 5, 5), "filled");
  assert.equal(orderState("Pendiente", 0, 5), "open");
  assert.equal(orderState("Pendiente", 2, 5), "partial");
  assert.equal(orderState("Cancelada", 0, 5), "canceled");
  assert.equal(orderState("Cancelada", 2, 5), "partial");
  assert.equal(orderState("Expirada", 0, 5), "expired");
  assert.equal(orderState("Rechazada", 0, 5), "rejected");
  assert.equal(orderState("???", 0, 5), "other");
});

test("broker orders: the parser reads numbers out of strings and skips junk", () => {
  const parsed = parseOrders([
    { orderId: "a", symbol: "keys", side: "sell", type: "trailing_stop", qty: "6", stopPrice: "323.493", trailPercent: "15", filledQty: "0", filledAvgPrice: null, status: "Pendiente", createdAt: "2026-10-12T13:13:17Z" },
    { orderId: "b", symbol: "GLW", side: "sell", type: "limit", qty: "3", limitPrice: "167", filledQty: "0", filledTotalAmount: "-", status: "Cancelada", createdAt: "2026-10-07T14:09:50Z" },
    { symbol: "", side: "buy" },
    null,
    "junk",
  ]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(
    { t: parsed[0].ticker, q: parsed[0].qty, s: parsed[0].stopPrice, p: parsed[0].trailPercent, st: parsed[0].state },
    { t: "KEYS", q: 6, s: 323.493, p: 15, st: "open" }
  );
  assert.equal(parsed[1].state, "canceled");
  assert.equal(parseOrders(null).length, 0);
});

// ── Trade journal ─────────────────────────────────────────────────────────────

import { buildJournal, inferSplit, originOf, type ReportAsk } from "../lib/market/trade-journal";

const fill = (id: string, ticker: string, side: "buy" | "sell", qty: number, price: number, createdAt: string, type = "limit"): BrokerOrder => ({
  id, ticker, side, type, qty, limitPrice: price, stopPrice: null, trailPercent: null,
  filledQty: qty, filledAvgPrice: price, state: "filled", status: "Completada", timeInForce: null, createdAt,
});
const ask = (date: string, buys: string[] = [], sells: string[] = [], stops: string[] = []): ReportAsk =>
  ({ date, buys: new Set(buys), sells: new Set(sells), stops: new Set(stops) });

test("journal: sells close the oldest buy first, net of commissions", () => {
  const { trades, summary } = buildJournal([
    fill("b1", "AAA", "buy", 10, 100, "2026-10-01T14:00:00Z"),
    fill("b2", "AAA", "buy", 10, 110, "2026-10-02T14:00:00Z"),
    fill("s1", "AAA", "sell", 15, 120, "2026-10-05T14:00:00Z"),
  ], [], {}, { AAA: 120 }, "2026-10-06T00:00:00Z");
  const [b2, b1] = trades;
  assert.equal(b1.status, "closed");
  assert.equal(b1.exitDate, "2026-10-05");
  // 10 × (120 − 100) less 0.30% on $1,000 bought and $1,200 sold.
  assert.ok(Math.abs(b1.realizedPl - (200 - 3 - 3.6)) < 1e-9);
  assert.equal(b2.status, "partial");
  assert.equal(b2.soldQty, 5);
  assert.ok(Math.abs(b2.unrealizedPl! - (5 * 10 - 3.3 / 2)) < 1e-9);
  assert.equal(summary.closed, 1);
});

test("journal: an order is the agent's when a report asked for it shortly before", () => {
  const asks = [ask("2026-10-15", ["SNDK"], ["SSG"], ["EBAY"])];
  assert.equal(originOf(fill("x", "SNDK", "buy", 1, 1, "2026-10-16T00:31:36Z"), asks), "agent");
  assert.equal(originOf(fill("x", "SNDK", "buy", 1, 1, "2026-10-25T14:00:00Z"), asks), "user");
  assert.equal(originOf(fill("x", "SNDK", "sell", 1, 1, "2026-10-16T14:00:00Z"), asks), "user");
  assert.equal(originOf(fill("x", "EBAY", "sell", 1, 1, "2026-10-15T14:00:00Z", "stop"), asks), "agent");
  assert.equal(originOf(fill("x", "EBAY", "sell", 1, 1, "2026-10-15T14:00:00Z"), asks), "user");
  // A manual override wins.
  const { trades } = buildJournal([fill("b", "SNDK", "buy", 1, 1, "2026-10-16T00:31:36Z")], asks, { b: "user" });
  assert.equal(trades[0].origin, "user");
  assert.ok(trades[0].originOverridden);
});

test("journal: a split restates the open lots in the new shares", () => {
  assert.equal(inferSplit({ price: 412, date: "2026-07-13" }, 23.5, "2026-07-15"), 20);
  assert.equal(inferSplit({ price: 1.28, date: "2025-04-07" }, 24.87, "2025-04-10"), 1 / 20);
  assert.equal(inferSplit({ price: 16, date: "2025-06-24" }, 5.72, "2025-07-18"), null);
  const { trades } = buildJournal([
    fill("b", "KORU", "buy", 2, 400, "2026-07-13T14:00:00Z"),
    fill("b2", "KORU", "buy", 10, 21, "2026-07-15T14:00:00Z"),
    fill("s", "KORU", "sell", 50, 22, "2026-08-01T14:00:00Z"),
  ], []);
  const first = trades.find((t) => t.id === "b")!;
  assert.equal(first.qty, 40);
  assert.equal(first.entryPrice, 20);
  assert.equal(first.status, "closed");
  assert.deepEqual(first.splits, ["20:1 2026-07-15"]);
});

import { legFillOrders } from "../lib/zesty/legs";

test("journal: a filled oto stop leg closes the trade its parent opened", () => {
  const parent = fill("p", "SKHY", "buy", 11, 141.26, "2026-10-16T05:18:43Z");
  const legs = { p: [{ legId: "l", side: "sell" as const, type: "stop", qty: 11, stopPrice: 136.5, filledQty: 11, filledAvgPrice: 136.51, filledAt: "2026-10-16T19:06:45Z", done: true }] };
  const extra = legFillOrders([parent], legs);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].ticker, "SKHY");
  const { trades } = buildJournal([parent, ...extra], [ask("2026-10-15", ["SKHY"], [], ["SKHY"])]);
  assert.equal(trades[0].status, "closed");
  assert.equal(trades[0].exitDate, "2026-10-16");
  assert.equal(trades[0].exitOrigin, "agent");
  // 11 × (136.51 − 141.26) less both commissions: the −$61.41 the broker shows, to the cent.
  assert.ok(Math.abs(trades[0].realizedPl - (-52.25 - 4.66158 - 4.50483)) < 0.01);
  // A leg that has not filled adds nothing.
  assert.equal(legFillOrders([parent], { p: [{ ...legs.p[0], filledQty: undefined }] }).length, 0);
});

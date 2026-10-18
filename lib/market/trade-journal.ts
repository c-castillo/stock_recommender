/**
 * The trade journal: every buy at Zesty, what became of it, and who decided it.
 *
 * Built from the broker's filled orders, not from portfolio snapshots: each
 * buy order is one trade, and the sells consume the open buys first-in,
 * first-out, so a trim closes the oldest shares and a trade can be partly
 * closed. P&L is net of the 0.30% commission on each side.
 *
 * Origin. An order is the agent's when a daily report asked for it: the same
 * ticker and side in that report's orders file or among its BUY/SELL rows, or a
 * sell stop on a name whose row carried a stop, placed within a few days of
 * the report. Everything else, and everything before the first report, is the
 * user's. The match is a guess from the record; a manual override (kept in
 * kv_store) wins over it.
 *
 * Dates. The broker gives a closed order its creation time and no fill time.
 * For a market or day order that is the fill's day; a GTC limit or a stop can
 * fill days later, and such dates are flagged `approx`.
 *
 * Splits. The order history is not split-adjusted, and a lot bought before a
 * split would be sold in shares of another size. A move of more than 4x
 * between two fills of a ticker less than ten days apart is read as a split
 * (KORU 20:1 in July 2026, ETHU 1:20 in April 2025), and the open lots are
 * restated in the new shares.
 */

import fs from "node:fs";
import path from "node:path";
import type { BrokerOrder } from "@/lib/zesty/orders";
import { COMMISSION_PC } from "@/lib/market/costs";

export type Origin = "agent" | "user";

/** What one daily report asked for, by ticker. */
export interface ReportAsk {
  date: string;
  buys: Set<string>;
  sells: Set<string>;
  /** Tickers whose row named a stop: a sell stop placed for them is the report's. */
  stops: Set<string>;
}

export interface JournalTrade {
  /** The buy order's id. */
  id: string;
  ticker: string;
  qty: number;
  entryDate: string;
  entryPrice: number;
  entryApprox: boolean;
  /** Date of the last sell that consumed this buy; null while shares remain. */
  exitDate: string | null;
  exitApprox: boolean;
  /** Average price of the shares sold so far. */
  exitPrice: number | null;
  soldQty: number;
  status: "open" | "partial" | "closed";
  realizedPl: number;
  /** On the shares still held, at the last price; null without one. */
  unrealizedPl: number | null;
  /** Realized + unrealized over the cost of the shares counted, %. */
  plPct: number | null;
  commissions: number;
  holdingDays: number;
  /** Who decided the entry: the field the journal is filtered by. */
  origin: Origin;
  originOverridden: boolean;
  /** Who decided the sells: "mixed" when both did. */
  exitOrigin: Origin | "mixed" | null;
  exitTypes: string[];
  /** Splits applied to this trade's shares, e.g. "20:1 2026-07-15". Quantity
   *  and prices are in post-split shares. */
  splits: string[];
}

export interface JournalSummary {
  trades: number;
  closed: number;
  wins: number;
  realizedPl: number;
  unrealizedPl: number;
  winRatePct: number | null;
}

/** How long after a report an order placed for it can still be created. */
const DAYS_AFTER_REPORT = 3;
const DAY = 86_400_000;

const dateOf = (iso: string) => iso.slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / DAY);

/** Resting orders whose creation day need not be the fill's. */
function isApprox(o: BrokerOrder): boolean {
  return o.type === "stop" || o.type === "trailing_stop" || (o.timeInForce ?? "").toLowerCase() === "gtc";
}

/** The asks of every report in `.whatsapp/reports`, oldest first. */
export function loadReportAsks(dir = path.join(process.cwd(), ".whatsapp", "reports")): ReportAsk[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const dates = [...new Set(files.map((f) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1]).filter(Boolean))] as string[];
  const read = (f: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      return null;
    }
  };
  return dates.sort().map((date) => {
    const ask: ReportAsk = { date, buys: new Set(), sells: new Set(), stops: new Set() };
    const recs = (read(`${date}.json`) as { recommendations?: unknown[] } | null)?.recommendations ?? [];
    for (const r of recs as { ticker?: string; action?: string; stopLoss?: string | null }[]) {
      const t = String(r.ticker ?? "").toUpperCase();
      if (!t) continue;
      if (r.action === "BUY") ask.buys.add(t);
      if (r.action === "SELL") ask.sells.add(t);
      if (r.stopLoss) ask.stops.add(t);
    }
    const orders = (read(`${date}.orders.json`) as { orders?: unknown[] } | null)?.orders ?? [];
    for (const o of orders as { ticker?: string; side?: string; source?: string; attachStop?: number | null }[]) {
      const t = String(o.ticker ?? "").toUpperCase();
      if (!t) continue;
      if (o.source === "stop" || o.attachStop) ask.stops.add(t);
      if (o.source === "stop") continue;
      (o.side === "buy" ? ask.buys : ask.sells).add(t);
    }
    return ask;
  });
}

/** Whether a report shortly before (or the evening before) the order asked for it. */
export function originOf(o: BrokerOrder, asks: ReportAsk[]): Origin {
  const isStop = o.type === "stop" || o.type === "trailing_stop";
  for (const a of asks) {
    const d = daysBetween(a.date, o.createdAt);
    if (d < -1 || d > DAYS_AFTER_REPORT) continue;
    if (o.side === "buy" && a.buys.has(o.ticker)) return "agent";
    if (o.side === "sell" && (a.sells.has(o.ticker) || (isStop && a.stops.has(o.ticker)))) return "agent";
  }
  return "user";
}

/** Ratios funds and companies split by; an inferred one snaps to the nearest. */
const SPLIT_RATIOS = [2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50, 100];

/** New shares per old share when two fills look like a split, else null. */
export function inferSplit(prev: { price: number; date: string }, price: number, date: string): number | null {
  const x = prev.price / price;
  if (daysBetween(prev.date, date) > 10 || (x < 4 && x > 1 / 4)) return null;
  const r = Math.max(x, 1 / x);
  const ratio = SPLIT_RATIOS.reduce((a, b) => (Math.abs(Math.log(b / r)) < Math.abs(Math.log(a / r)) ? b : a));
  return x > 1 ? ratio : 1 / ratio;
}

interface Lot {
  trade: JournalTrade;
  left: number;
  proceeds: number;
  exitOrigins: Set<Origin>;
}

export function buildJournal(
  orders: BrokerOrder[],
  asks: ReportAsk[],
  overrides: Record<string, Origin> = {},
  prices: Record<string, number> = {},
  today = new Date().toISOString()
): { trades: JournalTrade[]; summary: JournalSummary; unmatchedSells: number } {
  const fills = orders
    .filter((o) => o.filledQty > 0 && o.filledAvgPrice != null)
    // Buys before sells on the same instant, so a same-second round trip closes.
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.side === "buy" ? -1 : 1));
  const seen = new Set<string>();
  const lots = new Map<string, Lot[]>();
  const all: Lot[] = [];
  const lastFill = new Map<string, { price: number; date: string }>();
  let unmatchedSells = 0;

  for (const o of fills) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const price = o.filledAvgPrice!;
    const origin = overrides[o.id] ?? originOf(o, asks);
    const prev = lastFill.get(o.ticker);
    const split = prev ? inferSplit(prev, price, dateOf(o.createdAt)) : null;
    lastFill.set(o.ticker, { price, date: dateOf(o.createdAt) });
    if (split) {
      const label = split >= 1 ? `${split}:1` : `1:${Math.round(1 / split)}`;
      for (const lot of lots.get(o.ticker) ?? []) {
        if (lot.left <= 1e-9) continue;
        const t = lot.trade;
        lot.left *= split;
        t.qty *= split;
        t.soldQty *= split;
        t.entryPrice /= split;
        t.splits.push(`${label} ${dateOf(o.createdAt)}`);
      }
    }
    if (o.side === "buy") {
      const lot: Lot = {
        left: o.filledQty,
        proceeds: 0,
        exitOrigins: new Set(),
        trade: {
          id: o.id, ticker: o.ticker, qty: o.filledQty,
          entryDate: dateOf(o.createdAt), entryPrice: price, entryApprox: isApprox(o),
          exitDate: null, exitApprox: false, exitPrice: null, soldQty: 0, status: "open",
          realizedPl: 0, unrealizedPl: null, plPct: null,
          commissions: o.filledQty * price * COMMISSION_PC, holdingDays: 0,
          origin, originOverridden: o.id in overrides, exitOrigin: null, exitTypes: [], splits: [],
        },
      };
      lots.set(o.ticker, [...(lots.get(o.ticker) ?? []), lot]);
      all.push(lot);
      continue;
    }
    let qty = o.filledQty;
    for (const lot of lots.get(o.ticker) ?? []) {
      if (qty <= 1e-9) break;
      if (lot.left <= 1e-9) continue;
      const take = Math.min(lot.left, qty);
      lot.left -= take;
      qty -= take;
      lot.proceeds += take * price;
      lot.exitOrigins.add(origin);
      const t = lot.trade;
      t.soldQty += take;
      t.commissions += take * price * COMMISSION_PC;
      t.exitDate = dateOf(o.createdAt);
      t.exitApprox = isApprox(o);
      if (!t.exitTypes.includes(o.type)) t.exitTypes.push(o.type);
    }
    // Shares sold that no recorded buy covers (bought before the history starts).
    if (qty > 1e-6) unmatchedSells++;
  }

  const trades = all.map(({ trade: t, left, proceeds, exitOrigins }) => {
    const sold = t.soldQty;
    t.status = left <= 1e-6 ? "closed" : sold > 0 ? "partial" : "open";
    t.exitPrice = sold > 0 ? proceeds / sold : null;
    const entryCommission = t.qty * t.entryPrice * COMMISSION_PC;
    // The buy's commission is charged to the shares in proportion.
    t.realizedPl = sold > 0 ? proceeds - sold * t.entryPrice - (t.commissions - entryCommission) - entryCommission * (sold / t.qty) : 0;
    const last = prices[t.ticker];
    t.unrealizedPl = left > 1e-6 && last != null ? left * (last - t.entryPrice) - entryCommission * (left / t.qty) : null;
    const counted = sold + (t.unrealizedPl != null ? left : 0);
    t.plPct = counted > 0 ? ((t.realizedPl + (t.unrealizedPl ?? 0)) / (counted * t.entryPrice)) * 100 : null;
    t.exitOrigin = exitOrigins.size === 0 ? null : exitOrigins.size > 1 ? "mixed" : [...exitOrigins][0];
    t.holdingDays = Math.max(daysBetween(t.entryDate, t.status === "closed" ? t.exitDate! : today), 0);
    return t;
  });
  trades.reverse();

  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => t.realizedPl > 0).length;
  return {
    trades,
    unmatchedSells,
    summary: {
      trades: trades.length,
      closed: closed.length,
      wins,
      realizedPl: trades.reduce((s, t) => s + t.realizedPl, 0),
      unrealizedPl: trades.reduce((s, t) => s + (t.unrealizedPl ?? 0), 0),
      winRatePct: closed.length ? (wins / closed.length) * 100 : null,
    },
  };
}

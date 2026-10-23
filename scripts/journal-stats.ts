/**
 * CLI: the trade journal as a scorecard block — does the process make money?
 *
 *   pnpm exec tsx scripts/journal-stats.ts
 *
 * Win rate alone hides the problem the journal showed (51% won, profit factor
 * 0.64: the losers were bigger), so this prints expectancy, payoff and profit
 * factor by origin and by holding time, and the open positions that break the
 * LOSS DISCIPLINE rules (a loss past 10%, no progress after 20 sessions).
 * The preflight appends it to TODAY.scorecard.md. Run from the repo root.
 */

import { getBrokerOrders, getTradeOrigins, listPortfolio } from "@/lib/whatsapp/db";
import { buildJournal, loadReportAsks, type JournalTrade } from "@/lib/market/trade-journal";
import { legFillOrders } from "@/lib/zesty/legs";

/** LOSS DISCIPLINE in the playbook: the most a position may lose from its cost. */
const MAX_LOSS_PC = 10;
/** LOSS DISCIPLINE: sessions a position gets to start working. */
const TIME_STOP_SESSIONS = 20;
/** Closed trades an origin needs before its numbers are judged. */
const MIN_SAMPLE = 30;

const usd = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

/** Weekdays between two dates: close enough to trading sessions for a time stop. */
function sessionsBetween(a: string, b: string): number {
  let n = 0;
  for (let d = new Date(a + "T12:00:00Z"); d.toISOString().slice(0, 10) < b; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

function row(name: string, ts: JournalTrade[]): string {
  if (!ts.length) return `${name}|0|—|—|—|—|—|—|—`;
  const wins = ts.filter((t) => t.realizedPl > 0);
  const losses = ts.filter((t) => t.realizedPl < 0);
  const gw = wins.reduce((s, t) => s + t.realizedPl, 0);
  const gl = -losses.reduce((s, t) => s + t.realizedPl, 0);
  const avgW = wins.length ? wins.reduce((s, t) => s + (t.plPct ?? 0), 0) / wins.length : 0;
  const avgL = losses.length ? losses.reduce((s, t) => s + (t.plPct ?? 0), 0) / losses.length : 0;
  return [
    name,
    ts.length,
    `${Math.round((wins.length / ts.length) * 100)}%`,
    wins.length ? pct(avgW) : "—",
    losses.length ? pct(avgL) : "—",
    avgL ? (avgW / -avgL).toFixed(2) : "—",
    gl ? (gw / gl).toFixed(2) : "—",
    usd((gw - gl) / ts.length),
    usd(gw - gl) + (ts.length < MIN_SAMPLE ? " (small sample)" : ""),
  ].join("|");
}

function main() {
  const orders = getBrokerOrders();
  const book = listPortfolio();
  const prices: Record<string, number> = {};
  for (const p of book) if (p.current_price != null) prices[p.ticker] = p.current_price;
  const closedOrders = orders?.closed ?? [];
  const { trades } = buildJournal([...closedOrders, ...legFillOrders(closedOrders)], loadReportAsks(), getTradeOrigins(), prices);
  const today = new Date().toLocaleDateString("en-CA");
  const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const closed = trades.filter((t) => t.status === "closed");
  const by = (o: string, ts: JournalTrade[]) => ts.filter((t) => t.origin === o);
  const recent = closed.filter((t) => (t.exitDate ?? "") >= since90);

  const out: string[] = [];
  out.push(`\n## Trade journal: does the process make money? (from the broker's fills, to ${today})`);
  out.push(
    "Win rate is not the measure: a process that wins half its trades loses money when the average loss is bigger than the average win. " +
      "Read payoff (average win ÷ average loss) and profit factor (gross won ÷ gross lost; under 1.00 loses money). " +
      `"AI" is a trade a report asked for; "user" is everything else. Under ${MIN_SAMPLE} closed trades a row is a small sample: read direction, not decimals.`,
  );
  out.push("\nClosed trades|Trades|Won|Avg win|Avg loss|Payoff|Profit factor|Per trade|Net");
  out.push("---|---|---|---|---|---|---|---|---");
  out.push(row("AI, all", by("agent", closed)));
  out.push(row("User, all", by("user", closed)));
  out.push(row("AI, last 90 days", by("agent", recent)));
  out.push(row("User, last 90 days", by("user", recent)));

  out.push("\nBy holding time (all closed)|Trades|Won|Avg win|Avg loss|Payoff|Profit factor|Per trade|Net");
  out.push("---|---|---|---|---|---|---|---|---");
  for (const [name, lo, hi] of [["0–5 days", 0, 5], ["6–20 days", 6, 20], ["21–60 days", 21, 60], ["over 60 days", 61, Infinity]] as const)
    out.push(row(name, closed.filter((t) => t.holdingDays >= lo && t.holdingDays <= hi)));
  const big = closed.filter((t) => (t.plPct ?? 0) <= -15);
  const rest = closed.filter((t) => (t.plPct ?? 0) > -15);
  out.push(
    `\nLosses of 15% or more: ${big.length} trades, ${usd(big.reduce((s, t) => s + t.realizedPl, 0))}; ` +
      `every other closed trade together: ${usd(rest.reduce((s, t) => s + t.realizedPl, 0))}.`,
  );

  // Open positions against LOSS DISCIPLINE, per ticker. Zesty's average cost
  // lags a partial sale by a session (it showed CIEN at the pre-sale $372.97
  // until the next morning, then $340.35, the cost of the lots left), so the
  // cost is the journal's open lots when the two disagree.
  const open = trades.filter((t) => t.status !== "closed");
  const lines: string[] = [];
  const lags: string[] = [];
  for (const p of book) {
    if (p.current_price == null || !p.avg_cost || p.shares <= 0) continue;
    const lots = open.filter((t) => t.ticker === p.ticker);
    const left = lots.reduce((s, t) => s + t.qty - t.soldQty, 0);
    const lotCost = left > 0 ? lots.reduce((s, t) => s + (t.qty - t.soldQty) * t.entryPrice, 0) / left : null;
    const lagging = lotCost != null && Math.abs(left - p.shares) < 1e-6 && Math.abs(lotCost / p.avg_cost - 1) > 0.02;
    if (lagging) lags.push(`${p.ticker} broker $${p.avg_cost.toFixed(2)}, open lots $${lotCost!.toFixed(2)}`);
    const cost = lagging ? lotCost! : p.avg_cost;
    const loss = ((p.current_price - cost) / cost) * 100;
    const first = lots.map((t) => t.entryDate).sort()[0];
    const sessions = first ? sessionsBetween(first, today) : null;
    const flags: string[] = [];
    if (loss <= -MAX_LOSS_PC) flags.push(`loss past ${MAX_LOSS_PC}%`);
    if (sessions != null && sessions > TIME_STOP_SESSIONS && loss <= 0) flags.push(`${sessions} sessions and not working`);
    if (flags.length)
      lines.push(`${p.ticker}|${p.shares}|$${cost.toFixed(2)}${lagging ? " (lots)" : ""}|$${p.current_price.toFixed(2)}|${pct(loss)}|${first ?? "—"}|${sessions ?? "—"}|${flags.join("; ")}`);
  }
  out.push("\n### Open positions against LOSS DISCIPLINE");
  if (lines.length) {
    out.push("Ticker|Shares|Avg cost|Last|From cost|First lot|Sessions|Breach");
    out.push("---|---|---|---|---|---|---|---");
    out.push(...lines);
  } else out.push("None: every open position is within 10% of its cost, and none older than 20 sessions is under water.");
  if (lags.length)
    out.push(`\nThe broker's average cost disagrees with the open lots (it lags a partial sale by a session; the lots are used): ${lags.join("; ")}.`);
  console.log(out.join("\n"));
}

main();

/**
 * The volatile portfolio section of the analysis prompt: holdings, cash, live
 * prices and MA200 slopes, rendered as the table the playbook's rules refer to.
 *
 * Lives outside analyze.ts so the MCP server can build the same block without
 * pulling in the AI SDK — a chat client running the analysis needs identical
 * portfolio context to the in-app pipeline.
 */

import {
  listPortfolio,
  getCashBalance,
  getBuyingPower,
  getBrokerOrders,
  listActiveMainAnalystAdds,
} from "@/lib/whatsapp/db";
import { fetchMa200Slopes } from "@/lib/ma200";
import { fetchCurrentPrices, fetchQuotes, describeQuote, type Quote } from "@/lib/market/quotes";
import { fetchDailyCloses, highestCloseSince, openedOn } from "@/lib/market/history";
import type { BrokerOrders } from "@/lib/zesty/orders";
import { SECTORS, DEFENSIVE_LONGS, HEDGE_LEVERAGE, type SectorId } from "@/lib/market/sectors";
import { classifyTickers, classificationLabel } from "@/lib/market/classify";
import { fetchRrg, heading, type RrgPoint } from "@/lib/market/rrg";
import { fetchPerformance, renderPerformance } from "@/lib/market/performance";
import { BREAK_EVEN_WEEKS, CASH_APR, COMMISSION_PC, RISK_PER_POSITION, ROUND_TRIP_PC } from "@/lib/market/costs";

/** Rotation universe vs SPY: the eleven SPDR sectors, the AI-hardware themes
 *  the book trades, and the macro/defensive hedges. */
const RRG_UNIVERSE = [
  "XLK", "XLC", "XLY", "XLF", "XLE", "XLI", "XLB", "XLU", "XLP", "XLV", "XLRE",
  "SMH", "SOXX", "IGV", "EWY", "IBIT", "GLD", "TLT", "UUP",
];

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const slopeText = (s: number | null | undefined) =>
  s != null ? `${s >= 0 ? "↑+" : "↓"}${s.toFixed(2)}%` : "—";

export async function buildPortfolioContext(): Promise<string> {
  const positions = listPortfolio();
  const cash = getCashBalance();
  const portfolioTickers = positions.map((p) => p.ticker);
  const activeAdds = listActiveMainAnalystAdds();

  // Curated map first, TradingView for the rest — so a holding outside the map
  // lands in the exposure table by its real profile instead of the model's guess.
  const classes = await classifyTickers([...portfolioTickers, ...activeAdds.map((a) => a.ticker)]);
  const sectorOf = (t: string): SectorId | null => classes[t.toUpperCase()]?.sector ?? null;
  const isHedge = (t: string) => HEDGE_LEVERAGE[t.toUpperCase()] != null;
  const longs = positions.filter((p) => !isHedge(p.ticker));

  // Benchmarks and hedge instruments for every sector actually held, fetched
  // alongside the holdings so hedge sizing prices the present like entries do.
  const heldSectors = [
    ...new Set(longs.map((p) => sectorOf(p.ticker)).filter((s): s is SectorId => s !== null)),
  ];
  const benchmarks = [...new Set(heldSectors.map((id) => SECTORS[id].benchmark))];
  const hedgeTickers = [
    ...new Set([
      ...heldSectors.flatMap((id) => SECTORS[id].hedges.map((h) => h.ticker)),
      ...(positions.length > 0 ? DEFENSIVE_LONGS.map((d) => d.ticker) : []),
    ]),
  ];

  const broker = getBrokerOrders();
  const [slopes, quotes, marketPrices, rrgMarket, rrgHoldings, histories] = await Promise.all([
    positions.length > 0
      ? fetchMa200Slopes([...portfolioTickers, ...benchmarks])
      : Promise.resolve({} as Record<string, number | null>),
    portfolioTickers.length > 0
      ? fetchQuotes(portfolioTickers)
      : Promise.resolve({} as Record<string, Quote | null>),
    benchmarks.length + hedgeTickers.length > 0
      ? fetchCurrentPrices([...benchmarks, ...hedgeTickers])
      : Promise.resolve({} as Record<string, number | null>),
    positions.length > 0 ? fetchRrg([...RRG_UNIVERSE, ...benchmarks], "SPY") : Promise.resolve([]),
    // Each holding against its own sector benchmark: who leads and who lags
    // inside the same correlated bet.
    Promise.all(
      heldSectors.map((id) =>
        fetchRrg(
          longs.filter((p) => sectorOf(p.ticker) === id).map((p) => p.ticker),
          SECTORS[id].benchmark
        )
      )
    ).then((groups) => groups.flat()),
    Promise.all(longs.map((p) => fetchDailyCloses(p.ticker))),
  ]);
  const currentPrices: Record<string, number | null> = {};
  for (const t of portfolioTickers) currentPrices[t] = quotes[t]?.price ?? null;

  let section = "\n## Portfolio\n";

  if (cash !== null) {
    const money = (n: number) =>
      `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    // Open buy orders reserve cash: it still counts in the book's value, but a
    // new order can only spend what is left.
    const free = getBuyingPower();
    const reserved = free != null ? cash - free : 0;
    section +=
      `Cash: ${money(cash)}` +
      (reserved > 0.5
        ? ` — ${money(free!)} free for new orders, ${money(reserved)} reserved by open buy orders`
        : "") +
      "\n";
  }

  const exposure = new Map<SectorId | null, number>();
  const hedges: HeldHedge[] = [];
  let marketValueTotal = 0;

  if (positions.length > 0) {
    section += "\nTicker|Sector|Shares|AvgCost|Price|MktVal|P&L|MM200\n";
    section += "---|---|---|---|---|---|---|---\n";
    for (const p of positions) {
      // Prefer the live quote over the stored snapshot, and derive market value
      // and P&L from it. The stored columns go stale between syncs, and the
      // report was quoting day-old losses (GLW as -$702 when it was -$381)
      // while a fresher price sat in the "Live prices" block right below.
      const live = currentPrices[p.ticker] ?? null;
      const px = live ?? p.current_price;
      const mktVal = px != null ? px * p.shares : p.market_value;
      const pnl =
        px != null && p.avg_cost != null ? (px - p.avg_cost) * p.shares : p.unrealized_pl;
      const pnlPc =
        px != null && p.avg_cost != null && p.avg_cost !== 0
          ? ((px - p.avg_cost) / p.avg_cost) * 100
          : p.unrealized_pl_pc;

      const avgCost = p.avg_cost != null ? `$${p.avg_cost.toFixed(2)}` : "—";
      const price = px != null ? `$${px.toFixed(2)}` : "—";
      const mv = mktVal != null ? `$${mktVal.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—";
      const pl = pnl != null
        ? `$${pnl.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}(${pnlPc != null ? pnlPc.toFixed(1) + "%" : "—"})`
        : "—";
      const sector = sectorOf(p.ticker);
      const leverage = HEDGE_LEVERAGE[p.ticker.toUpperCase()];
      if (mktVal != null) {
        marketValueTotal += mktVal;
        if (leverage != null) hedges.push({ ticker: p.ticker, leverage, shares: p.shares, value: mktVal, pl });
        else exposure.set(sector, (exposure.get(sector) ?? 0) + mktVal);
      }
      const sectorStr =
        leverage != null
          ? `Hedge (-${leverage}x inverse ETF)`
          : classificationLabel(classes[p.ticker.toUpperCase()]);
      section += `${p.ticker}|${sectorStr}|${p.shares}|${avgCost}|${price}|${mv}|${pl}|${slopeText(slopes[p.ticker])}\n`;
    }
    section += renderSectorExposure(exposure, hedges, cash ?? 0, slopes, marketPrices);
    section += renderRrg(rrgMarket, rrgHoldings);
    // Live total (market value + cash) is what the money-weighted return needs;
    // the broker's own snapshot lags a day.
    section += renderPerformance(await fetchPerformance(marketValueTotal + (cash ?? 0)));
    section += renderCosts(cash ?? 0, hedges.reduce((a, h) => a + h.value, 0), marketValueTotal + (cash ?? 0));
    section += renderTrailing(
      longs.map((p, i) => ({ ticker: p.ticker, shares: p.shares, price: currentPrices[p.ticker], closes: histories[i] })),
      broker
    );
    section += renderBrokerOrders(broker, positions);
  } else {
    section += "No positions.\n";
  }

  section += `\nRules: MM200↑=long, MM200↓=avoid. Existing: add/hold/exit. New buy: check cash. Size 5-20%. Stop: existing+profit→trailing% (e.g."15%"), new→price level (e.g."$810").\n`;

  // Sector of the active ADD names not held, so a new BUY can be weighed
  // against the sector it would add to.
  const held = new Set(portfolioTickers);
  const addSectors = activeAdds
    .filter((a) => !held.has(a.ticker))
    .map((a) => `${a.ticker}=${classificationLabel(classes[a.ticker.toUpperCase()])}`);
  if (addSectors.length > 0) {
    section += `\nSectors of active ADDs not held: ${addSectors.join(", ")}\n`;
  }

  // Live prices for portfolio tickers — used as entryPrice for BUYs.
  const priceEntries = Object.entries(currentPrices).filter(([, v]) => v !== null) as [string, number][];
  if (priceEntries.length > 0) {
    priceEntries.sort(([a], [b]) => a.localeCompare(b));
    // Say what each price is: a close is decided, a pre-market print is not.
    section +=
      "\n## Prices (Yahoo Finance) — use Price as entryPrice for BUY. Price is the regular session's; " +
      "a pre-market or after-hours print is a hint of the open and never decides a stop on a close:\n" +
      "Ticker|Price|What it is\n---|---|---\n" +
      priceEntries.map(([t, p]) => `${t}|$${p.toFixed(2)}|${quotes[t] ? describeQuote(quotes[t]!) : "—"}`).join("\n") +
      "\n";
  }

  return section;
}


interface HeldHedge {
  ticker: string;
  leverage: number;
  shares: number;
  value: number;
  /** P&L since entry, already formatted like the holdings table. */
  pl: string;
}

function renderSectorExposure(
  exposure: Map<SectorId | null, number>,
  held: HeldHedge[],
  cash: number,
  slopes: Record<string, number | null>,
  prices: Record<string, number | null>
): string {
  const invested = [...exposure.values()].reduce((a, b) => a + b, 0);
  const hedgeValue = held.reduce((a, h) => a + h.value, 0);
  const total = invested + hedgeValue + cash;
  if (invested <= 0 || total <= 0) return "";

  const rows = [...exposure.entries()].sort(([, a], [, b]) => b - a);
  let out =
    "\n## Sector exposure (longs only, % of total incl. cash and hedges)\n" +
    "Sector|Theme|MktVal|%Total|Benchmark|Bench MM200|Long-only hedges (live)\n" +
    "---|---|---|---|---|---|---\n";

  const themes = new Map<string, number>();
  for (const [id, value] of rows) {
    const pct = ((value / total) * 100).toFixed(1) + "%";
    if (id === null) {
      out += `unclassified|—|${usd(value)}|${pct}|—|—|—\n`;
      continue;
    }
    const s = SECTORS[id];
    themes.set(s.theme, (themes.get(s.theme) ?? 0) + value);
    const benchPx = prices[s.benchmark];
    const bench = `${s.benchmark}${benchPx != null ? ` $${benchPx.toFixed(2)}` : ""}`;
    const hedges = s.hedges
      .map((h) => `${h.ticker} ${prices[h.ticker] != null ? `$${prices[h.ticker]!.toFixed(2)}` : "—"} [${h.note}]`)
      .join("; ");
    out += `${s.label}|${s.theme}|${usd(value)}|${pct}|${bench}|${slopeText(slopes[s.benchmark])}|${hedges}\n`;
  }

  out +=
    "\nBy theme: " +
    [...themes.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([t, v]) => `${t} ${((v / total) * 100).toFixed(1)}%`)
      .join(", ") +
    ` · Cash ${((cash / total) * 100).toFixed(1)}%\n`;

  out +=
    "Defensive longs (hedge only when this session's macro supports them): " +
    DEFENSIVE_LONGS.map(
      (d) => `${d.ticker} ${prices[d.ticker] != null ? `$${prices[d.ticker]!.toFixed(2)}` : "—"} [${d.note}]`
    ).join("; ") +
    "\n";

  if (held.length > 0) {
    const pct = (v: number) => ((v / total) * 100).toFixed(1) + "%";
    const short = held.reduce((a, h) => a + h.value * h.leverage, 0);
    const top = [...themes.entries()].sort(([, a], [, b]) => b - a)[0];
    out +=
      "\n## Hedges held (inverse ETFs — short exposure, not in the sector table)\n" +
      "Ticker|Leverage|Shares|MktVal|%Total|Short exposure|P&L since entry\n---|---|---|---|---|---|---\n" +
      held
        .map(
          (h) =>
            `${h.ticker}|-${h.leverage}x|${h.shares}|${usd(h.value)}|${pct(h.value)}|${usd(h.value * h.leverage)}|${h.pl}\n`
        )
        .join("") +
      `Capital in hedges ${pct(hedgeValue)} of total · short exposure ${usd(short)} (${pct(short)})` +
      (top ? ` · ${top[0]} ${pct(top[1])} gross, ${pct(top[1] - short)} net if every hedge is set against it` : "") +
      "\n";
  }

  return out;
}

/** Commissions and the interest on cash, in the dollars of this book. */
function renderCosts(cash: number, hedgeCapital: number, total: number): string {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const perWeek = (n: number) => money((n * CASH_APR) / 52);
  let out =
    "\n## Costs (apply them to every order; see the playbook's COSTS AND THE HURDLE)\n" +
    `- Commission: ${pct(COMMISSION_PC)} of the order's value per side. A round trip, or a swap of one name for another, costs ${pct(ROUND_TRIP_PC)} of the amount: $1,000 moved costs ${money(1000 * ROUND_TRIP_PC)}.\n` +
    `- Cash earns ${(CASH_APR * 100).toFixed(1)}% a year at the broker: ${money(cash)} earns ${money(cash * CASH_APR)} a year, ${perWeek(cash)} a week. Every $1,000 moved out of cash gives up ${perWeek(1000)} a week.\n` +
    `- Break-even: a new position must gain ${pct(ROUND_TRIP_PC)} to pay its commissions, plus ${pct(CASH_APR / 52)} for each week held to match cash. A round trip closed inside ${BREAK_EVEN_WEEKS.toFixed(0)} weeks costs more in commissions than the cash would have earned in that time.\n`;
  if (total > 0) {
    const budget = total * RISK_PER_POSITION;
    out += `- Risk budget: ${pct(RISK_PER_POSITION)} of the book is ${money(budget)}, the most one position may lose between its entry and its stop. Shares for a new BUY = ${money(budget)} ÷ (entry − stop), or the size the weight rule gives, whichever is fewer.\n`;
  }
  if (hedgeCapital > 0) {
    out += `- Hedges: ${money(hedgeCapital)} of capital gives up ${perWeek(hedgeCapital)} a week of interest, and opening and closing it costs ${money(hedgeCapital * ROUND_TRIP_PC)}, before the daily decay of a leveraged fund.\n`;
  }
  return out;
}

interface TrailingInput {
  ticker: string;
  shares: number;
  price: number | null;
  closes: { date: string; close: number }[];
}

/** The high a trailing stop is measured from, per held long. */
function renderTrailing(rows: TrailingInput[], broker: BrokerOrders | null): string {
  const lines: string[] = [];
  // Where the broker's history starts: for a position older than that, the
  // high is counted from there and is only a lower bound.
  const oldest = (broker?.closed ?? []).reduce<string | null>(
    (a, o) => (a == null || o.createdAt < a ? o.createdAt : a),
    null
  )?.slice(0, 10) ?? null;
  for (const r of rows) {
    const since = openedOn(r.ticker, r.shares, broker?.closed ?? []);
    const top = highestCloseSince(r.closes, since, oldest);
    if (!top) continue;
    const off = r.price != null ? `${(100 * (r.price / top.high - 1)).toFixed(1)}%` : "—";
    lines.push(
      `${r.ticker}|${top.exact ? top.since : `before ${top.since} (high since then: the real one may be higher)`}|$${top.high.toFixed(2)}|${top.highDate}|${off}|` +
        [10, 15, 20].map((p) => `$${(top.high * (1 - p / 100)).toFixed(2)}`).join("|")
    );
  }
  if (lines.length === 0) return "";
  return (
    "\n## Highest close since entry (what a trailing stop is measured from)\n" +
    "A trailing level only rises: use these, not the level of an older report. " +
    "Entry dates come from the broker's fills. A level above today's price means that trail fired at some " +
    "point since entry: if the exit was not taken and a later report re-set the stop (Evidence Discipline 5), " +
    "the high counts from the day it was re-set, which that report's stop line names; say which case it is.\n" +
    "Ticker|Held since|Highest close|On|Price vs high|10% trail|15% trail|20% trail\n---|---|---|---|---|---|---|---\n" +
    lines.join("\n") +
    "\n"
  );
}

/** What rests at the broker, and where it disagrees with the book. */
function renderBrokerOrders(
  broker: BrokerOrders | null,
  positions: { ticker: string; shares: number }[]
): string {
  if (!broker) return "\n## Orders at the broker\nNot read: the sync did not return them.\n";
  const when = new Date(broker.at * 1000);
  const stamp = `${when.toLocaleDateString("en-CA")} ${when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  let out = `\n## Orders at the broker (read ${stamp})\n`;
  if (broker.open.length === 0) out += "None open.\n";
  else {
    out += "Ticker|Side|Type|Shares|Level|Placed\n---|---|---|---|---|---\n";
    for (const o of broker.open) {
      const level =
        o.type === "trailing_stop"
          ? `${o.trailPercent ?? "?"}% trail, now $${o.stopPrice?.toFixed(2) ?? "?"}`
          : o.stopPrice != null
            ? `stop $${o.stopPrice.toFixed(2)}`
            : o.limitPrice != null
              ? `limit $${o.limitPrice.toFixed(2)}`
              : "market";
      out += `${o.ticker}|${o.side}|${o.type}|${o.qty ?? "—"}|${level}|${o.createdAt.slice(0, 10)}\n`;
    }
  }
  const notes: string[] = [];
  const held = new Map(positions.map((p) => [p.ticker, p.shares]));
  const sells = new Map<string, number>();
  for (const o of broker.open) if (o.side === "sell") sells.set(o.ticker, (sells.get(o.ticker) ?? 0) + (o.qty ?? 0));
  for (const [t, q] of sells) {
    const have = held.get(t) ?? 0;
    if (have === 0) notes.push(`${t}: a sell order rests for ${q} sh but none are held`);
    else if (q > have + 1e-6) notes.push(`${t}: open sells total ${q} sh against ${have} held`);
  }
  const stopped = new Set(broker.open.filter((o) => o.side === "sell" && /stop/.test(o.type)).map((o) => o.ticker));
  const bare = positions.filter((p) => HEDGE_LEVERAGE[p.ticker.toUpperCase()] == null && !stopped.has(p.ticker));
  if (bare.length > 0) notes.push(`no stop resting: ${bare.map((p) => p.ticker).join(", ")}`);
  if (notes.length > 0) out += notes.map((n) => `- ${n}\n`).join("");
  return out;
}

function renderRrg(market: RrgPoint[], holdings: RrgPoint[]): string {
  if (market.length === 0 && holdings.length === 0) return "";
  const row = (p: RrgPoint) =>
    `${p.ticker}|${p.benchmark}|${p.quadrant}|${p.from}|${p.ratio.toFixed(1)}|${p.momentum.toFixed(1)}|${heading(p)}\n`;
  const header =
    "Ticker|vs|Quadrant|4w ago|RS-Ratio|RS-Mom|Heading\n---|---|---|---|---|---|---\n";
  const order: Record<string, number> = { Leading: 0, Improving: 1, Weakening: 2, Lagging: 3 };
  const sorted = (ps: RrgPoint[]) => [...ps].sort((a, b) => order[a.quadrant] - order[b.quadrant]);

  let out = `\n## Relative Rotation (weekly, as of ${(market[0] ?? holdings[0]).asOf}; JdK approximation)\n`;
  if (market.length > 0) out += "Sectors, themes and macro hedges vs SPY:\n" + header + sorted(market).map(row).join("");
  if (holdings.length > 0) out += "\nHoldings vs their sector benchmark:\n" + header + sorted(holdings).map(row).join("");
  return out;
}

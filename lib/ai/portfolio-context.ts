/**
 * The volatile portfolio section of the analysis prompt: holdings, cash, live
 * prices and MA200 slopes, rendered as the table the playbook's rules refer to.
 *
 * Lives outside analyze.ts so the MCP server can build the same block without
 * pulling in the AI SDK — a chat client running the analysis needs identical
 * portfolio context to the in-app pipeline.
 */

import { listPortfolio, getCashBalance, listActiveDrCsAdds } from "@/lib/whatsapp/db";
import { fetchMa200Slopes } from "@/lib/ma200";
import { fetchCurrentPrices } from "@/lib/market/quotes";
import { SECTORS, DEFENSIVE_LONGS, sectorOf, type SectorId } from "@/lib/market/sectors";
import { fetchRrg, heading, type RrgPoint } from "@/lib/market/rrg";
import { fetchPerformance, renderPerformance } from "@/lib/market/performance";

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

  // Benchmarks and hedge instruments for every sector actually held, fetched
  // alongside the holdings so hedge sizing prices the present like entries do.
  const heldSectors = [
    ...new Set(positions.map((p) => sectorOf(p.ticker)).filter((s): s is SectorId => s !== null)),
  ];
  const benchmarks = [...new Set(heldSectors.map((id) => SECTORS[id].benchmark))];
  const hedgeTickers = [
    ...new Set([
      ...heldSectors.flatMap((id) => SECTORS[id].hedges.map((h) => h.ticker)),
      ...(positions.length > 0 ? DEFENSIVE_LONGS.map((d) => d.ticker) : []),
    ]),
  ];

  const [slopes, currentPrices, marketPrices, rrgMarket, rrgHoldings] = await Promise.all([
    positions.length > 0
      ? fetchMa200Slopes([...portfolioTickers, ...benchmarks])
      : Promise.resolve({} as Record<string, number | null>),
    portfolioTickers.length > 0
      ? fetchCurrentPrices(portfolioTickers)
      : Promise.resolve({} as Record<string, number | null>),
    benchmarks.length + hedgeTickers.length > 0
      ? fetchCurrentPrices([...benchmarks, ...hedgeTickers])
      : Promise.resolve({} as Record<string, number | null>),
    positions.length > 0 ? fetchRrg([...RRG_UNIVERSE, ...benchmarks], "SPY") : Promise.resolve([]),
    // Each holding against its own sector benchmark: who leads and who lags
    // inside the same correlated bet.
    Promise.all(
      [...new Set(positions.map((p) => sectorOf(p.ticker)).filter((s): s is SectorId => s !== null))].map((id) =>
        fetchRrg(
          positions.filter((p) => sectorOf(p.ticker) === id).map((p) => p.ticker),
          SECTORS[id].benchmark
        )
      )
    ).then((groups) => groups.flat()),
  ]);

  let section = "\n## Portfolio\n";

  if (cash !== null) {
    section += `Cash: $${cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
  }

  const exposure = new Map<SectorId | null, number>();
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
      if (mktVal != null) {
        exposure.set(sector, (exposure.get(sector) ?? 0) + mktVal);
        marketValueTotal += mktVal;
      }
      const sectorStr = sector ? SECTORS[sector].label : "unclassified — classify it";
      section += `${p.ticker}|${sectorStr}|${p.shares}|${avgCost}|${price}|${mv}|${pl}|${slopeText(slopes[p.ticker])}\n`;
    }
    section += renderSectorExposure(exposure, cash ?? 0, slopes, marketPrices);
    section += renderRrg(rrgMarket, rrgHoldings);
    // Live total (market value + cash) is what the money-weighted return needs;
    // the broker's own snapshot lags a day.
    section += renderPerformance(await fetchPerformance(marketValueTotal + (cash ?? 0)));
  } else {
    section += "No positions.\n";
  }

  section += `\nRules: MM200↑=long, MM200↓=avoid. Existing: add/hold/exit. New buy: check cash. Size 5-20%. Stop: existing+profit→trailing% (e.g."15%"), new→price level (e.g."$810").\n`;

  // Sector of the active ADD names not held, so a new BUY can be weighed
  // against the sector it would add to.
  const held = new Set(portfolioTickers);
  const addSectors = listActiveDrCsAdds()
    .filter((a) => !held.has(a.ticker))
    .map((a) => {
      const id = sectorOf(a.ticker);
      return `${a.ticker}=${id ? SECTORS[id].label : "unclassified"}`;
    });
  if (addSectors.length > 0) {
    section += `\nSectors of active ADDs not held: ${addSectors.join(", ")}\n`;
  }

  // Live prices for portfolio tickers — used as entryPrice for BUYs.
  const priceEntries = Object.entries(currentPrices).filter(([, v]) => v !== null) as [string, number][];
  if (priceEntries.length > 0) {
    priceEntries.sort(([a], [b]) => a.localeCompare(b));
    section +=
      "\n## Live prices (Yahoo Finance) — use as entryPrice for BUY:\nTicker|Price\n---|---\n" +
      priceEntries.map(([t, p]) => `${t}|$${p.toFixed(2)}`).join("\n") +
      "\n";
  }

  return section;
}


function renderSectorExposure(
  exposure: Map<SectorId | null, number>,
  cash: number,
  slopes: Record<string, number | null>,
  prices: Record<string, number | null>
): string {
  const invested = [...exposure.values()].reduce((a, b) => a + b, 0);
  const total = invested + cash;
  if (invested <= 0 || total <= 0) return "";

  const rows = [...exposure.entries()].sort(([, a], [, b]) => b - a);
  let out =
    "\n## Sector exposure (% of total incl. cash)\n" +
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

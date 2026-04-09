import { upsertPosition, listPortfolio } from "@/lib/whatsapp/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }

  const positions = parsePositions(raw);

  if (positions.length === 0) {
    return Response.json(
      { error: "No se encontraron posiciones en el JSON" },
      { status: 422 }
    );
  }

  for (const p of positions) upsertPosition(p.ticker, p.shares, p.avg_cost, p.current_price, p.market_value, p.unrealized_pl, p.unrealized_pl_pc);

  return Response.json({ imported: positions.length, positions: listPortfolio() });
}

// ── Parser ────────────────────────────────────────────────────────────────────

interface ParsedPosition {
  ticker: string;
  shares: number;
  avg_cost: number | null;
  current_price: number | null;
  market_value: number | null;
  unrealized_pl: number | null;
  unrealized_pl_pc: number | null;
}

function parsePositions(data: unknown): ParsedPosition[] {
  // Unwrap if wrapped in an object (e.g. { positions: [...], data: [...] })
  const rows: unknown[] = Array.isArray(data)
    ? data
    : (typeof data === "object" && data !== null
        ? (Object.values(data as Record<string, unknown>).find(Array.isArray) as unknown[] ?? [])
        : []);

  const results: ParsedPosition[] = [];

  for (const item of rows) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;

    // Nested asset object (Zesty structure)
    const asset = (typeof obj.asset === "object" && obj.asset !== null)
      ? obj.asset as Record<string, unknown>
      : null;

    const ticker = str(obj.symbol ?? obj.ticker ?? obj.stock ?? obj.code ?? asset?.symbol);
    const shares = num(obj.qty ?? obj.shares ?? obj.quantity ?? obj.units ?? obj.amount);
    const avg_cost = num(obj.avgPrice ?? obj.avg_cost ?? obj.avgCost ?? obj.average_cost ?? obj.averagePrice ?? obj.avg_price ?? obj.costBasis ?? obj.cost_basis);
    const current_price = num(asset?.price ?? obj.current_price ?? obj.currentPrice ?? obj.price ?? obj.last_price ?? obj.lastPrice ?? obj.market_price ?? obj.marketPrice ?? obj.close);
    const market_value = num(obj.marketValue ?? obj.market_value ?? obj.totalValue ?? obj.total_value);
    const unrealized_pl = num(obj.unrealizedPl ?? obj.unrealized_pl ?? obj.unrealizedPnl ?? obj.pnl);
    const unrealized_pl_pc = num(obj.unrealizedPlPc ?? obj.unrealized_pl_pc ?? obj.unrealizedPnlPc ?? obj.pnlPc);

    if (!ticker || shares === null || shares <= 0) continue;
    results.push({ ticker: ticker.toUpperCase().trim(), shares, avg_cost, current_price, market_value, unrealized_pl, unrealized_pl_pc });
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

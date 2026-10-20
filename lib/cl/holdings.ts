/**
 * The Chilean book, read from Itaú Corredora's "Informe Mensual de Cartera"
 * PDF: there is no connector for this broker, so its statement is the source
 * of truth for shares, average cost, the money-market fund and what is
 * pending settlement.
 *
 * The parser works on `pdftotext -layout` output and keeps only what the
 * analysis needs: the client's name, RUT and address never leave the PDF.
 */
import { execFileSync } from "node:child_process";

export interface ClPosition {
  ticker: string;
  company: string | null;
  /** Itaú's own sector label ("Servicios Publicos"). */
  rubro: string | null;
  shares: number;
  /** Average purchase price, CLP. */
  avgCost: number;
  /** Price on the statement date, CLP. */
  statementPrice: number;
  marketValue: number;
  dividendsReceived: number;
  /** Return on cost as Itaú prints it, as a fraction. */
  returnPc: number;
}

export interface ClFund {
  code: string;
  name: string | null;
  units: number;
  unitValue: number;
  value: number;
}

export interface ClStatement {
  /** "Hasta": the date the positions are valued at. */
  asOf: string;
  from: string | null;
  positions: ClPosition[];
  funds: ClFund[];
  /** Cash in the account ("Caja"), CLP. */
  cash: number;
  /** Trades and dividends not yet settled ("Operaciones por Liquidar"), CLP. */
  pendingSettlement: number;
  /** The statement's total, CLP. */
  totalValue: number;
  usdClp: number | null;
  projectedDividends: { next30: number; next31to90: number };
  /** Yearly yield of the money-market fund, from the first and last unit value
   *  in the statement's movements (null with fewer than seven days between). */
  fundYield: number | null;
}

/** "1.234.567,89" → 1234567.89; "+ 22,01%" → 22.01. */
export function clNumber(s: string): number {
  const t = s.replace(/\s|%|\$/g, "");
  return Number(t.replace(/\./g, "").replace(",", "."));
}

const DATE = /(\d{2})\/(\d{2})\/(\d{4})/;
const iso = (d: string) => {
  const m = DATE.exec(d);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/** The first amount after a label on the same line. */
function amountAfter(text: string, label: RegExp): number {
  const m = new RegExp(label.source + String.raw`\s+(-?[\d.]+(?:,\d+)?)`).exec(text);
  return m ? clNumber(m[1]) : 0;
}

export function parseStatement(text: string): ClStatement {
  const lines = text.split("\n");
  const asOf = iso(/Hasta:\s+(\d{2}\/\d{2}\/\d{4})/.exec(text)?.[1] ?? "");
  if (!asOf) throw new Error("Not an Itaú portfolio statement: no 'Hasta:' date");
  const from = iso(/Desde:\s+(\d{2}\/\d{2}\/\d{4})/.exec(text)?.[1] ?? "");

  const positions: ClPosition[] = [];
  lines.forEach((line, i) => {
    // TICKER  Activo:  libre  préstamo  garantía  plazo  compra  último  valor  dividendos  ±rent%
    const m = /^\s*([A-Z][A-Z0-9-]*)\s+Activo:\s+(.+)$/.exec(line);
    if (!m) return;
    const cols = m[2].replace(/([+-])\s+(?=\d)/g, "$1").trim().split(/\s+/);
    if (cols.length < 9) return;
    const [libre, , , , compra, ultimo, valor, dividendos, rent] = cols;
    let rubro: string | null = null;
    let company: string | null = null;
    for (const next of lines.slice(i + 1, i + 5)) {
      if (/Activo:/.test(next)) break;
      const r = /Rubro:\s+(.+?)(?:\s{2,}|$)/.exec(next);
      if (r) { rubro = r[1].trim(); continue; }
      const name = next.trim();
      if (!company && name && !/:/.test(name) && !/^[\d\s.,]+$/.test(name)) company = name;
    }
    positions.push({
      ticker: m[1],
      company,
      rubro,
      shares: clNumber(libre),
      avgCost: clNumber(compra),
      statementPrice: clNumber(ultimo),
      marketValue: clNumber(valor),
      dividendsReceived: clNumber(dividendos),
      returnPc: clNumber(rent) / 100,
    });
  });

  // Money-market and other mutual funds: CODE  units  pledged  avg unit  unit  value  rent%
  const funds: ClFund[] = [];
  const fundStart = lines.findIndex((l) => /Detalle Cartera Fondos Mutuos/.test(l));
  if (fundStart >= 0) {
    for (let i = fundStart; i < lines.length; i++) {
      if (/Valor Total de la Cartera/.test(lines[i])) break;
      const f = /^\s*([A-Z][A-Z0-9]{3,})\s+([\d.]+,\d+)\s+([\d.]+,\d+)\s+([\d.]+,\d+)\s+([\d.]+,\d+)\s+([\d.]+,\d+)/.exec(lines[i]);
      if (!f) continue;
      const name = lines[i + 1]?.trim() || null;
      funds.push({
        code: f[1],
        name,
        units: clNumber(f[2]),
        unitValue: clNumber(f[5]),
        value: clNumber(f[6]),
      });
    }
  }

  // The fund's unit value on each movement date gives its realised yield.
  let fundYield: number | null = null;
  const marks = [...text.matchAll(/^(\d{2}\/\d{2}\/\d{4})\s+\d+\s+FM\s+.+?\s([\d.]+,\d{4,})\s+([\d.]+,\d{4,})\s+[\d.]+\s*$/gm)]
    .map((m) => ({ date: iso(m[1])!, unit: clNumber(m[3]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (marks.length >= 2) {
    const a = marks[0];
    const b = marks[marks.length - 1];
    const days = (Date.parse(b.date) - Date.parse(a.date)) / 86_400_000;
    if (days >= 7 && a.unit > 0) fundYield = Math.pow(b.unit / a.unit, 365 / days) - 1;
  }

  const usd = /Valor USD\s+\$\s+([\d.]+,\d+)/.exec(text);
  const flows = /^\s*Dividendos\s+([\d.]+)\s+([\d.]+)\s*$/m.exec(text);
  const total = /Pesos \(CLP\)\s+([\d.]+)/.exec(text);

  return {
    asOf,
    from,
    positions,
    funds,
    cash: amountAfter(text, /\n\s+Caja/),
    pendingSettlement: amountAfter(text, /Operaciones por Liquidar/),
    totalValue: total ? clNumber(total[1]) : 0,
    usdClp: usd ? clNumber(usd[1]) : null,
    projectedDividends: flows
      ? { next30: clNumber(flows[1]), next31to90: clNumber(flows[2]) }
      : { next30: 0, next31to90: 0 },
    fundYield,
  };
}

/** Text of a statement PDF, by poppler's pdftotext (installed with poppler). */
export function statementText(pdfPath: string): string {
  return execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** Problems that make the parse untrustworthy; empty when it adds up. */
export function checkStatement(s: ClStatement): string[] {
  const problems: string[] = [];
  if (s.positions.length === 0) problems.push("no equity positions found");
  for (const p of s.positions) {
    const v = p.shares * p.statementPrice;
    if (Math.abs(v - p.marketValue) > Math.max(2, p.marketValue * 0.001))
      problems.push(`${p.ticker}: ${p.shares} × ${p.statementPrice} = ${v.toFixed(0)}, statement says ${p.marketValue}`);
  }
  const sum =
    s.positions.reduce((a, p) => a + p.marketValue, 0) +
    s.funds.reduce((a, f) => a + f.value, 0) +
    s.cash +
    s.pendingSettlement;
  if (s.totalValue && Math.abs(sum - s.totalValue) > s.totalValue * 0.001)
    problems.push(`positions + funds + cash + pending = ${sum.toFixed(0)}, statement total ${s.totalValue}`);
  return problems;
}

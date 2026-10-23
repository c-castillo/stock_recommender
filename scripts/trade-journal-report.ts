/**
 * CLI: the trade journal as a report, in Markdown and PDF.
 *
 *   pnpm exec tsx scripts/trade-journal-report.ts [--no-pdf]
 *
 * Same data as /bitacora (the broker's filled orders, the daily reports'
 * asks, the manual origins), written to .whatsapp/reports/bitacora-DATE.md
 * and .pdf. Run from the repo root so the database resolves.
 */

import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { getBrokerOrders, getTradeOrigins, listPortfolio } from "@/lib/whatsapp/db";
import { buildJournal, loadReportAsks, type JournalTrade } from "@/lib/market/trade-journal";
import { legFillOrders } from "@/lib/zesty/legs";

const usd = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const price = (n: number | null) =>
  n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;
const pct = (n: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);
const qty = (n: number) => String(+n.toFixed(4));
const ORIGIN = { agent: "Agente", user: "Usuario", mixed: "Mixto" } as const;
const STATUS = { open: "Abierto", partial: "Parcial", closed: "Cerrado" } as const;

/** A table both renderers share: headers, rows, and which columns align right. */
interface Table { head: string[]; rows: string[][]; right: number[] }
type Block = { h: string; level: 2 | 3 } | { p: string } | { table: Table };

function summarize(trades: JournalTrade[]) {
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => t.realizedPl > 0);
  const losses = closed.filter((t) => t.realizedPl < 0);
  const avg = (xs: JournalTrade[]) => (xs.length ? xs.reduce((s, t) => s + t.realizedPl, 0) / xs.length : null);
  return {
    count: trades.length,
    closed: closed.length,
    open: trades.length - closed.length,
    realized: trades.reduce((s, t) => s + t.realizedPl, 0),
    unrealized: trades.reduce((s, t) => s + (t.unrealizedPl ?? 0), 0),
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    avgWin: avg(wins),
    avgLoss: avg(losses),
    commissions: trades.reduce((s, t) => s + t.commissions, 0),
  };
}

function tradeRows(trades: JournalTrade[]): Table {
  return {
    head: ["Ticker", "Origen", "Compra", "P. compra", "Venta", "P. venta", "Acciones", "Estado", "P&L", "%", "Días"],
    right: [3, 5, 6, 8, 9, 10],
    rows: trades.map((t) => {
      const pl = t.soldQty === 0 && t.unrealizedPl == null ? null : t.realizedPl + (t.unrealizedPl ?? 0);
      const origin = ORIGIN[t.origin] + (t.originOverridden ? "*" : "") +
        (t.exitOrigin && t.exitOrigin !== t.origin ? ` (venta: ${ORIGIN[t.exitOrigin]})` : "");
      return [
        t.ticker + (t.splits.length ? ` (split ${t.splits.join(", ")})` : ""),
        origin,
        t.entryDate + (t.entryApprox ? " ≈" : ""),
        price(t.entryPrice),
        t.exitDate ? t.exitDate + (t.exitApprox ? " ≈" : "") : "—",
        t.exitPrice == null ? "—" : price(t.exitPrice) + (t.exitTypes.some((x) => x.includes("stop")) ? " stop" : ""),
        t.status === "partial" ? `${qty(t.qty)} (vend. ${qty(t.soldQty)})` : qty(t.qty),
        STATUS[t.status],
        pl == null ? "—" : usd(pl) + (t.status !== "closed" ? " nr" : ""),
        pct(t.plPct),
        String(t.holdingDays),
      ];
    }),
  };
}

function build(): { title: string; blocks: Block[] } {
  const orders = getBrokerOrders();
  const prices: Record<string, number> = {};
  for (const p of listPortfolio()) if (p.current_price != null) prices[p.ticker] = p.current_price;
  const closed = orders?.closed ?? [];
  const { trades, unmatchedSells } = buildJournal([...closed, ...legFillOrders(closed)], loadReportAsks(), getTradeOrigins(), prices);
  const today = new Date().toLocaleDateString("en-CA");
  const first = trades.at(-1)?.entryDate ?? today;
  const agent = trades.filter((t) => t.origin === "agent");
  const user = trades.filter((t) => t.origin === "user");
  const blocks: Block[] = [];

  blocks.push({
    p: `Generado el ${today} · ${trades.length} trades desde ${first} · órdenes leídas de Zesty el ` +
      `${orders ? new Date(orders.at * 1000).toLocaleString("es-CL").replace(/\.$/, "") : "—"}. P&L neto del 0,30% de comisión por lado; ` +
      `"nr" = no realizado, al último precio.`,
  });

  blocks.push({ h: "Resumen por origen", level: 2 });
  const s = { Agente: summarize(agent), Usuario: summarize(user), Total: summarize(trades) };
  blocks.push({
    table: {
      head: ["", "Trades", "Cerrados", "Abiertos", "P&L realizado", "No realizado", "Win rate", "Gan. prom.", "Pérd. prom.", "Comisiones"],
      right: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      rows: Object.entries(s).map(([k, v]) => [
        k, String(v.count), String(v.closed), String(v.open), usd(v.realized), usd(v.unrealized),
        v.winRate == null ? "—" : `${v.winRate.toFixed(0)}%`,
        v.avgWin == null ? "—" : usd(v.avgWin), v.avgLoss == null ? "—" : usd(v.avgLoss), usd(v.commissions),
      ]),
    },
  });

  blocks.push({ h: "P&L realizado por año", level: 2 });
  const years = [...new Set(trades.filter((t) => t.status === "closed").map((t) => t.exitDate!.slice(0, 4)))].sort();
  blocks.push({
    table: {
      head: ["Año", "Cerrados", "Agente", "Usuario", "Total", "Win rate"],
      right: [1, 2, 3, 4, 5],
      rows: years.map((y) => {
        const c = trades.filter((t) => t.status === "closed" && t.exitDate!.startsWith(y));
        const sum = (xs: JournalTrade[]) => xs.reduce((a, t) => a + t.realizedPl, 0);
        return [y, String(c.length), usd(sum(c.filter((t) => t.origin === "agent"))), usd(sum(c.filter((t) => t.origin === "user"))),
          usd(sum(c)), `${((c.filter((t) => t.realizedPl > 0).length / c.length) * 100).toFixed(0)}%`];
      }),
    },
  });

  blocks.push({ h: "Trades del agente", level: 2 });
  blocks.push(agent.length ? { table: tradeRows(agent) } : { p: "Ninguno todavía." });

  blocks.push({ h: "Posiciones abiertas", level: 2 });
  blocks.push({ table: tradeRows(trades.filter((t) => t.status !== "closed")) });

  blocks.push({ h: "Todos los trades cerrados", level: 2 });
  blocks.push({ table: tradeRows(trades.filter((t) => t.status === "closed")) });

  blocks.push({ h: "Metodología", level: 2 });
  for (const p of [
    "Un trade es una orden de compra ejecutada. Las ventas consumen las compras más antiguas primero (FIFO), así que una venta parcial deja el trade como Parcial.",
    "Agente: la orden coincide con una compra, venta o stop que pidió un reporte diario (mismo ticker y lado, creada entre el día anterior y 3 días después del reporte). Todo lo demás es Usuario. * = origen corregido a mano en /bitacora.",
    "≈: Zesty no da la hora de ejecución; la fecha es la de creación de la orden, y un stop o una orden GTC pudo ejecutarse después.",
    "Splits: el historial de Zesty no está ajustado. Un salto de precio de más de 4x en menos de 10 días se lee como split, y las cantidades y precios del trade se expresan en acciones posteriores al split.",
    unmatchedSells
      ? `${unmatchedSells} ventas no tienen una compra registrada que las cubra (acciones anteriores al historial) y no entran en el P&L.`
      : "",
  ].filter(Boolean)) blocks.push({ p });

  return { title: `Bitácora de trades — ${today}`, blocks };
}

function toMarkdown(title: string, blocks: Block[]): string {
  const esc = (c: string) => c.replace(/\|/g, "\\|");
  const out = [`# ${title}`, ""];
  for (const b of blocks) {
    if ("h" in b) out.push(`${"#".repeat(b.level)} ${b.h}`, "");
    else if ("p" in b) out.push(b.p, "");
    else {
      const { head, rows, right } = b.table;
      out.push(`| ${head.map(esc).join(" | ")} |`);
      out.push(`|${head.map((_, i) => (right.includes(i) ? "---:" : "---")).join("|")}|`);
      for (const r of rows) out.push(`| ${r.map(esc).join(" | ")} |`);
      out.push("");
    }
  }
  return out.join("\n");
}

function toHtml(title: string, blocks: Block[]): string {
  const esc = (c: string) => c.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const tone = (c: string) => (/^−\$/.test(c) || /^-\d/.test(c) ? "neg" : /^\$|^\+/.test(c) ? "pos" : "");
  const body = blocks.map((b) => {
    if ("h" in b) return `<h${b.level}>${esc(b.h)}</h${b.level}>`;
    if ("p" in b) return `<p>${esc(b.p)}</p>`;
    const { head, rows, right } = b.table;
    // Colour the P&L columns only: a price or a commission is not a gain.
    const signed = (i: number) => /^(P&L|%|No realizado|Agente|Usuario|Total)/.test(head[i]);
    const cls = (i: number, c = "") => [right.includes(i) ? "r" : "", signed(i) ? tone(c) : ""].filter(Boolean).join(" ");
    return `<table><thead><tr>${head.map((h, i) => `<th class="${cls(i)}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c, i) => `<td class="${cls(i, c)}">${esc(c)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
  });
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body { font: 9px/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; margin: 0; }
    h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 12px; margin: 16px 0 6px; text-transform: uppercase; border-bottom: 2px solid #1a1a1a; padding-bottom: 2px; }
    p { margin: 4px 0; color: #444; } table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; }
    th { text-align: left; font-size: 8px; text-transform: uppercase; color: #666; border-bottom: 1.5px solid #1a1a1a; padding: 3px 4px; }
    td { padding: 2.5px 4px; border-bottom: 0.5px solid #ddd; white-space: nowrap; } tr { page-break-inside: avoid; }
    .r { text-align: right; font-variant-numeric: tabular-nums; } .pos { color: #1a8f3c; } .neg { color: #d93425; }
  </style></head><body><h1>${esc(title)}</h1>${body.join("\n")}</body></html>`;
}

async function main() {
  const { title, blocks } = build();
  const dir = path.join(process.cwd(), ".whatsapp", "reports");
  const base = path.join(dir, `bitacora-${new Date().toLocaleDateString("en-CA")}`);
  fs.writeFileSync(`${base}.md`, toMarkdown(title, blocks));
  console.log(`${base}.md`);
  if (process.argv.includes("--no-pdf")) return;
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(toHtml(title, blocks), { waitUntil: "load" });
    await page.pdf({
      path: `${base}.pdf`, format: "A4", landscape: true, printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
      displayHeaderFooter: true, headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:7px;width:100%;text-align:center;color:#888">${title} · <span class="pageNumber"></span>/<span class="totalPages"></span></div>`,
    });
    console.log(`${base}.pdf`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

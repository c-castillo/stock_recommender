/**
 * Render a Chilean report as one self-contained HTML page for the phone.
 *
 * Reads `.whatsapp/cl/reports/<date>.md`, `<date>.json` and
 * `<date>.orders.json` and writes `<date>.html`: the orders to type into the
 * Itaú app first, then the book, then the full report folded by section. The
 * Chilean run publishes it as its own private artifact, apart from the US
 * page. No database, no network, no model call.
 *
 * Usage: pnpm exec tsx scripts/cl/report-page.ts [YYYY-MM-DD] [out.html]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CL_REPORTS } from "@/lib/cl/config";
import { blocks, esc, inline, PAGE_CSS } from "@/lib/report/page";

interface Rec {
  ticker: string;
  company?: string | null;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entryPrice?: string | null;
  stopLoss?: string | null;
  role?: "dividend" | "growth" | "bet" | null;
  reasoning: string;
}

interface ClOrder {
  ticker: string;
  side: "buy" | "sell" | "redeem" | "subscribe";
  qty?: number | null;
  limitPrice?: number | null;
  amountCLP?: number | null;
  mustFill?: boolean;
  stopLevel?: number | null;
  condition?: string | null;
  waitsFor?: string | null;
  why?: string | null;
}

const date =
  process.argv[2] ??
  readdirSync(CL_REPORTS).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().pop()?.slice(0, 10);
if (!date) throw new Error(`No report found in ${CL_REPORTS}`);
const outPath = process.argv[3] ?? join(CL_REPORTS, `${date}.html`);

const md = readFileSync(join(CL_REPORTS, `${date}.md`), "utf8").replace(/```json[\s\S]*$/i, "").trimEnd();
const recs: Rec[] = JSON.parse(readFileSync(join(CL_REPORTS, `${date}.json`), "utf8")).recommendations;
const ordersPath = join(CL_REPORTS, `${date}.orders.json`);
const orders: ClOrder[] = existsSync(ordersPath) ? (JSON.parse(readFileSync(ordersPath, "utf8")).orders ?? []) : [];
const run = existsSync(join(CL_REPORTS, `${date}.run.json`))
  ? (JSON.parse(readFileSync(join(CL_REPORTS, `${date}.run.json`), "utf8")) as {
      session?: string; phase?: string; statement?: { asOf: string; ageDays: number };
    })
  : {};

const n = (x?: number | null, d = 0) =>
  x == null ? "?" : x.toLocaleString("es-CL", { minimumFractionDigits: d, maximumFractionDigits: d });

// ── Orders, as typed into the Itaú app ───────────────────────────────────────

const orderCards = orders
  .map((o, i) => {
    const key = `${i}-${o.side}-${o.ticker}`;
    const fund = o.side === "redeem" || o.side === "subscribe";
    const pill = o.side === "buy" || o.side === "subscribe" ? "buy" : "sell";
    const verb = fund ? (o.side === "redeem" ? "REDEEM" : "SUBSCRIBE") : o.side.toUpperCase();
    const size = fund
      ? `CLP ${n(o.amountCLP)}`
      : `${n(o.qty)} sh <span class="x">×</span> CLP ${n(o.limitPrice, 2)} <span class="x">=</span> CLP ${n((o.qty ?? 0) * (o.limitPrice ?? 0))}`;
    const rows = [
      fund ? ["Fund", o.ticker] : ["Type", `limit, day${o.mustFill ? " — must fill" : ""}`],
      o.stopLevel != null ? ["Stop", `closing basis: sell if it closes under CLP ${n(o.stopLevel, 2)}`] : null,
      o.condition ? ["Condition", o.condition] : null,
      o.waitsFor ? ["After", o.waitsFor] : null,
    ].filter(Boolean) as string[][];
    return `<article class="order">
  <header><h3>${esc(o.ticker)}</h3><span class="pill ${pill}">${verb}</span></header>
  <div class="size">${size}</div>
  <dl>${rows.map(([k, v]) => `<div class="kv"><dt>${esc(k)}</dt><dd>${inline(v)}</dd></div>`).join("")}</dl>
  ${o.why ? `<p class="src">${inline(o.why)}</p>` : ""}
  <label class="done"><input type="checkbox" data-key="${esc(key)}"> Placed at Itaú</label>
</article>`;
  })
  .join("\n");

const heldRows = recs
  .filter((r) => !/^Not held\b/i.test(r.reasoning))
  .map((r) => `<li>
  <div class="row"><b class="tk">${esc(r.ticker)}</b><span class="tag">${r.action}</span>${r.role ? `<span class="tag">${esc(r.role)}</span>` : ""}<span class="num">conf. ${r.confidence}</span></div>
  <div class="row sub"><span>${inline(r.entryPrice ?? "")}</span>${r.stopLoss ? `<span class="num">stop ${inline(r.stopLoss)}</span>` : ""}</div>
</li>`)
  .join("\n");
const others = recs.filter((r) => /^Not held\b/i.test(r.reasoning));
const otherRows = others
  .map((r) => `<li><div class="row"><b class="tk">${esc(r.ticker)}</b><span class="tag">${r.action.toLowerCase()}</span><span class="num">${inline(r.entryPrice ?? "")} · ${r.confidence}</span></div></li>`)
  .join("\n");

// ── The report, split at its ## sections ─────────────────────────────────────

const parts = md.split(/^(?=## )/m);
const intro = parts[0].startsWith("## ") ? "" : parts.shift()!;
const title = /^# (.+)$/m.exec(intro)?.[1] ?? `Chilean report ${date}`;
const lede = intro.replace(/^# .+$/m, "").trim();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
const sections = parts.map((p, i) => {
  const [first, ...rest] = p.split("\n");
  const name = first.replace(/^## /, "");
  return { id: slug(name), name, html: blocks(rest.join("\n")), open: i === 0 || /recommend/i.test(name) };
});

const day = new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const session = run.session
  ? new Date(`${run.session}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
  : null;
const note =
  (run.phase === "open"
    ? `Written while Santiago was open; the last close is ${session ?? "?"}. Stops that wait for a close are not decided.`
    : `Prices are the Santiago closes of ${session ?? "the last session"}. Orders are for the next open.`) +
  (run.statement ? ` Book: Itaú statement of ${run.statement.asOf}${run.statement.ageDays > 7 ? ` (${run.statement.ageDays} days old)` : ""}.` : "");

const html = `<title>Chilean Book Report</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Nunito:wght@400;600;800&display=swap">
<style>
${PAGE_CSS}</style>

<div class="page">
  <header class="top">
    <span class="eyebrow">🇨🇱 ${esc(day)} · Itaú</span>
    <h1>${inline(title)}</h1>
    <p class="warn">${esc(note)} Re-quote before typing any order.</p>
  </header>

  <section class="block" id="orders">
    <h2>Orders to place in the Itaú app</h2>
    ${orderCards || `<p class="note">No orders in this report.</p>`}
  </section>

  <section class="block" id="book">
    <h2>The book</h2>
    <ul class="list card">
${heldRows}
    </ul>
    ${others.length ? `<details class="fold card"><summary>Not held: watchlist and avoid (${others.length})</summary>
      <ul class="list">
${otherRows}
      </ul>
    </details>` : ""}
  </section>

  <section class="block" id="report">
    <h2>Full report</h2>
    <nav>${sections.map((s) => `<a href="#${s.id}">${esc(s.name)}</a>`).join("")}</nav>
    ${lede ? `<details class="sec"><summary>About this run</summary><div class="prose">${blocks(lede)}</div></details>` : ""}
${sections
  .map((s) => `<details class="sec" id="${s.id}"${s.open ? " open" : ""}><summary>${inline(s.name)}</summary><div class="prose">\n${s.html}\n</div></details>`)
  .join("\n")}
  </section>
</div>

<script>
(function () {
  document.querySelectorAll('nav a').forEach(function (a) {
    a.addEventListener('click', function () {
      var el = document.getElementById(a.getAttribute('href').slice(1));
      if (el) el.open = true;
    });
  });
  // "Placed" ticks are a per-phone convenience, kept for this report's date only.
  var KEY = 'cl-report-placed:${date}', placed = {};
  try { placed = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  document.querySelectorAll('.done input').forEach(function (box) {
    box.checked = !!placed[box.dataset.key];
    box.addEventListener('change', function () {
      placed[box.dataset.key] = box.checked;
      try { localStorage.setItem(KEY, JSON.stringify(placed)); } catch (e) {}
    });
  });
})();
</script>
`;

writeFileSync(outPath, html);
console.log(`${outPath} — ${orders.length} orders, ${recs.length - others.length} held, ${others.length} not held, ${sections.length} sections`);

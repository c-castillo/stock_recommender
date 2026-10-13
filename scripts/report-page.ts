/**
 * Render a daily report as one self-contained HTML page for the phone.
 *
 * Reads `.whatsapp/reports/<date>.md` and `<date>.json` (what /daily-run
 * step 3 saves) and writes `<date>.html`: the orders first, then the book,
 * then the full report in collapsible sections. /daily-run publishes that
 * file as a private Claude artifact, so the report can be read and acted on
 * away from the computer. No database, no network, no model call.
 *
 * Usage: pnpm exec tsx scripts/report-page.ts [YYYY-MM-DD] [out.html]
 * Without a date it takes the newest report.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), ".whatsapp", "reports");

interface Rec {
  ticker: string;
  company?: string | null;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entryPrice?: string | null;
  priceTarget?: string | null;
  stopLoss?: string | null;
  reasoning: string;
  sources?: string[];
}

// ── Markdown → HTML (the subset the reports use) ──────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const inline = (s: string) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

const cells = (row: string) =>
  row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());

function table(rows: string[]): string {
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  // Up to three columns of prose stack into blocks on a phone; wider tables
  // keep their grid and scroll sideways inside their own container.
  const kind = head.length <= 3 ? "t-stack" : "t-wide";
  const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
  const trs = body
    .map((r) => `<tr>${head.map((_, i) => `<td>${inline(r[i] ?? "")}</td>`).join("")}</tr>`)
    .join("\n");
  return `<div class="scroll"><table class="${kind}"><thead><tr>${th}</tr></thead><tbody>\n${trs}\n</tbody></table></div>`;
}

function blocks(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,4}) (.+)$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (line.startsWith("|") && /^\|[\s:|-]+$/.test(lines[i + 1] ?? "")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      out.push(table(rows));
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(lines[i++].slice(2));
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join("\n")}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4} |- |\|)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

// ── Inputs ────────────────────────────────────────────────────────────────────

const date =
  process.argv[2] ??
  readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().pop()?.slice(0, 10);
if (!date) throw new Error(`No report found in ${DIR}`);
const outPath = process.argv[3] ?? join(DIR, `${date}.html`);

const md = readFileSync(join(DIR, `${date}.md`), "utf8").replace(/```json[\s\S]*$/i, "").trimEnd();
const recs: Rec[] = JSON.parse(readFileSync(join(DIR, `${date}.json`), "utf8")).recommendations;

// ── The actionable part, from the JSON ────────────────────────────────────────

// /daily-run makes every order row's reasoning start with the order itself
// ("BUY 67 sh ≈ $701 — …") and every held row with "HOLD 16 sh = $6,814.88 — …".
const SIZED = /^(BUY|SELL|HOLD)\s+([\d,.]+)\s*sh\s*[=≈]\s*\$([\d,.]+)\s*(?:—|-)?\s*/;

const sized = recs.flatMap((r) => {
  const m = SIZED.exec(r.reasoning);
  return m ? [{ r, verb: m[1], shares: m[2], amount: m[3], why: r.reasoning.slice(m[0].length) }] : [];
});
const orders = sized.filter((s) => s.verb !== "HOLD");
const held = sized.filter((s) => s.verb === "HOLD");
const others = recs.filter((r) => !SIZED.test(r.reasoning));

const field = (label: string, value?: string | null) =>
  value ? `<div class="kv"><dt>${label}</dt><dd>${inline(value)}</dd></div>` : "";

const orderCards = orders
  .map(({ r, verb, shares, amount, why }, n) => {
    const src = r.sources?.length ? `<p class="src">${r.sources.map(esc).join(" · ")}</p>` : "";
    return `<article class="order ${verb.toLowerCase()}">
  <header>
    <span class="pill ${verb.toLowerCase()}">${verb}</span>
    <h3>${esc(r.ticker)}</h3>
    <span class="co">${esc(r.company ?? "")}</span>
  </header>
  <p class="size"><b>${esc(shares)}</b> sh <span class="x">≈</span> <b>$${esc(amount)}</b></p>
  <dl>
    ${field("Price", r.entryPrice)}
    ${field("Stop", r.stopLoss)}
    ${field("Target", r.priceTarget)}
    ${field("Confidence", String(r.confidence))}
  </dl>
  <details><summary>Why</summary><p>${inline(why)}</p>${src}</details>
  <label class="done"><input type="checkbox" id="done-${n}" data-key="${esc(`${r.ticker}:${verb}`)}"> Sent</label>
</article>`;
  })
  .join("\n");

const heldRows = held
  .map(({ r, shares, amount }) => {
    const hedge = /—\s*hedge\b/i.test(r.reasoning) ? ' <span class="tag">hedge</span>' : "";
    return `<li>
  <div class="row"><b class="tk">${esc(r.ticker)}</b>${hedge}<span class="num">${esc(shares)} sh · $${esc(amount)}</span></div>
  <div class="row sub"><span>${inline(r.entryPrice ?? "")}</span><span class="num">conf. ${r.confidence}</span></div>
  ${r.stopLoss ? `<div class="sub">Stop: ${inline(r.stopLoss)}</div>` : ""}
</li>`;
  })
  .join("\n");

const otherRows = others
  .map((r) => {
    const label = /^Not held\s*—\s*([^.]+)\./.exec(r.reasoning)?.[1] ?? r.action.toLowerCase();
    return `<li><div class="row"><b class="tk">${esc(r.ticker)}</b><span class="tag">${esc(label)}</span><span class="num">${inline(r.entryPrice ?? "")} · ${r.confidence}</span></div></li>`;
  })
  .join("\n");

// ── The report, split at its ## sections ──────────────────────────────────────

const parts = md.split(/^(?=## )/m);
const intro = parts[0].startsWith("## ") ? "" : parts.shift()!;
const title = /^# (.+)$/m.exec(intro)?.[1] ?? `Report ${date}`;
const lede = intro.replace(/^# .+$/m, "").trim();

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";

const sections = parts.map((p, n) => {
  const [first, ...rest] = p.split("\n");
  const name = first.replace(/^## /, "");
  return { id: slug(name), name, html: blocks(rest.join("\n")), open: n === 0 || /recommend/i.test(name) };
});

// The pre-set orders ("Standing conditionals") live in the prose only. Lift
// them next to the orders when the report has them under that name.
const cond = /^\*\*[^*\n]*conditional[^*\n]*\*\*[^\n]*\n\n((?:- .+\n?)+)/im.exec(md);
const conditionals = cond
  ? `<section class="block" id="conditionals">
  <h2>If a level breaks</h2>
  <p class="note">Each waits for a close. Re-quote on the day.</p>
  ${blocks(cond[1])}
</section>`
  : "";

const day = new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", {
  weekday: "short", day: "numeric", month: "short", year: "numeric",
});

// What the prices in this report are depends on when it was written, and the
// page is rendered right after: closes only once the session of that date has
// ended. Exchange holidays are not known here and read as a normal weekday.
function priceNote(): string {
  const ny = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const part = (t: string) => ny.find((p) => p.type === t)!.value;
  const nyDate = `${part("year")}-${part("month")}-${part("day")}`;
  const minutes = (Number(part("hour")) % 24) * 60 + Number(part("minute"));
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const short = (d: Date) =>
    d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  if (weekday === 0 || weekday === 6) {
    const friday = new Date(`${date}T12:00:00`);
    friday.setDate(friday.getDate() - (weekday === 6 ? 1 : 2));
    return `Markets are closed. Prices are the closes of ${short(friday)}.`;
  }
  // A run after local midnight is dated a day ahead of New York: the session
  // that just closed there is the one priced.
  if (date > nyDate) {
    const closed = new Date(`${nyDate}T12:00:00`);
    const back = closed.getDay() === 0 ? 2 : closed.getDay() === 6 ? 1 : minutes < 16 * 60 ? 1 : 0;
    closed.setDate(closed.getDate() - back);
    if (closed.getDay() === 0) closed.setDate(closed.getDate() - 2);
    if (closed.getDay() === 6) closed.setDate(closed.getDate() - 1);
    return `Prices are the closes of ${short(closed)}.`;
  }
  if (date === nyDate && minutes < 9 * 60 + 30) {
    return "Pre-market run. Prices are the previous session's closes; stops that wait for a close are not decided.";
  }
  if (date === nyDate && minutes < 16 * 60) {
    return `Intraday run at ${part("hour")}:${part("minute")} New York. Prices are not closes; stops that wait for a close are not decided.`;
  }
  return `Prices are the closes of ${day}.`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

const html = `<title>Daily Trading Report</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Nunito:wght@400;600;800&display=swap">
<style>
/* One column for the thumb: orders, the book, then the report folded by section. */
:root {
  --bg: #EDE8D5; --card: #FFFFFF; --shade: #F6F1DF;
  --ink: #1a1a1a; --muted: #5c574a; --line: #1a1a1a; --drop: #1a1a1a;
  --yellow: #F5C518; --red: #FF4D3D; --green: #2ECC71; --on-accent: #1a1a1a;
  --display: "Archivo Black", "Arial Black", Impact, sans-serif;
  --body: "Nunito", system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #17150f; --card: #232017; --shade: #2c281d;
  --ink: #F3EEDC; --muted: #b0a98f; --line: #6b654f; --drop: #000000;
  --yellow: #F5C518; --red: #FF6B5E; --green: #3ddc84; --on-accent: #1a1a1a;
  color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #17150f; --card: #232017; --shade: #2c281d;
  --ink: #F3EEDC; --muted: #b0a98f; --line: #6b654f; --drop: #000000;
  --yellow: #F5C518; --red: #FF6B5E; --green: #3ddc84; --on-accent: #1a1a1a;
  color-scheme: dark }

body { background: var(--bg); color: var(--ink); font: 400 16px/1.55 var(--body); }
.page { max-width: 46rem; margin: 0 auto; padding-inline: 16px; padding-block: 20px 48px; display: flex; flex-direction: column; gap: 20px; }
.page > * { min-width: 0; }
h1, h2, h3, h4 { margin: 0; text-wrap: balance; }
h1 { font: 400 1.45rem/1.2 var(--display); }
h2 { font: 400 1.1rem/1.25 var(--display); }
p, ul, dl { margin: 0; }
ul { padding-left: 1.15rem; display: flex; flex-direction: column; gap: 8px; }
code { font-size: .85em; background: var(--shade); padding: 0 .3em; border-radius: 4px; overflow-wrap: anywhere; }
.eyebrow { font: 800 .75rem/1 var(--body); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.note { color: var(--muted); font-size: .9rem; }
.num { font-variant-numeric: tabular-nums; }

.top { display: flex; flex-direction: column; gap: 8px; }
.warn { background: var(--yellow); color: var(--on-accent); border: 2px solid var(--line); border-radius: 12px; padding: 10px 12px; font-weight: 800; font-size: .92rem; }

.block { display: flex; flex-direction: column; gap: 12px; }
.card { background: var(--card); border: 2px solid var(--line); border-radius: 16px; box-shadow: 4px 4px 0 var(--drop); }

.order { background: var(--card); border: 2px solid var(--line); border-radius: 16px; box-shadow: 4px 4px 0 var(--drop); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.order header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.order h3 { font: 400 1.5rem/1 var(--display); }
.order .co { color: var(--muted); font-size: .9rem; }
.pill { font: 800 .8rem/1 var(--body); letter-spacing: .06em; padding: 5px 9px; border: 2px solid var(--line); border-radius: 999px; color: var(--on-accent); align-self: center; }
.pill.buy { background: var(--green); }
.pill.sell { background: var(--red); }
.size { font-size: 1.15rem; font-variant-numeric: tabular-nums; }
.size .x { color: var(--muted); }
dl { display: grid; grid-template-columns: 1fr; gap: 6px; }
.kv { display: grid; grid-template-columns: 6.5rem 1fr; gap: 8px; font-size: .95rem; }
.kv dt { color: var(--muted); font-weight: 600; }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.order details p { font-size: .92rem; margin-top: 8px; }
.order .src { color: var(--muted); font-size: .82rem; }
.done { display: flex; align-items: center; gap: 8px; font-weight: 800; padding-top: 8px; border-top: 2px dashed var(--line); }
.done input { width: 22px; height: 22px; accent-color: var(--green); }
.order:has(.done input:checked) { opacity: .55; }

.list { list-style: none; padding: 0; gap: 0; }
.list li { padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 2px; }
.list li:last-child { border-bottom: 0; }
.row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.row .num { margin-left: auto; text-align: right; }
.tk { font: 400 1rem/1.2 var(--display); }
.sub { color: var(--muted); font-size: .88rem; }
.tag { font: 800 .7rem/1 var(--body); letter-spacing: .05em; text-transform: uppercase; background: var(--shade); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }

nav { display: flex; flex-wrap: wrap; gap: 8px; }
nav a { font-weight: 800; font-size: .85rem; color: var(--ink); text-decoration: none; background: var(--card); border: 2px solid var(--line); border-radius: 999px; padding: 6px 11px; box-shadow: 2px 2px 0 var(--drop); }
a:focus-visible, summary:focus-visible, input:focus-visible { outline: 3px solid var(--yellow); outline-offset: 2px; }

details.sec { background: var(--card); border: 2px solid var(--line); border-radius: 16px; box-shadow: 4px 4px 0 var(--drop); scroll-margin-top: 12px; }
summary { cursor: pointer; font-weight: 800; }
details.sec > summary { font: 400 1.05rem/1.25 var(--display); padding: 14px; }
details.fold > summary { padding: 12px 14px; }
.prose { padding: 0 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.prose > * { min-width: 0; }
.prose h3 { font: 800 1.02rem/1.3 var(--body); padding-top: 8px; border-top: 2px solid var(--line); }
.prose h4 { font: 800 .95rem/1.3 var(--body); }
.prose p, .prose li { overflow-wrap: anywhere; }

.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: .88rem; font-variant-numeric: tabular-nums; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { background: var(--shade); font-weight: 800; }
tr:last-child td { border-bottom: 0; }
.t-wide { min-width: 44rem; }
@media (max-width: 640px) {
  .t-stack thead { display: none; }
  .t-stack tr { display: block; padding: 10px; border-bottom: 1px solid var(--line); }
  .t-stack tr:last-child { border-bottom: 0; }
  .t-stack td { display: block; padding: 0; border: 0; overflow-wrap: anywhere; }
  .t-stack td:first-child { font-weight: 800; }
  .t-stack td:empty { display: none; }
  .t-stack td + td { margin-top: 4px; }
  .t-stack td:last-child:not(:first-child) { color: var(--muted); }
}
</style>

<div class="page">
  <header class="top">
    <span class="eyebrow">${esc(day)}</span>
    <h1>${inline(title)}</h1>
    <p class="warn">${esc(priceNote())} Re-quote before sending any order.</p>
  </header>

  <section class="block" id="orders">
    <h2>Orders</h2>
    ${orderCards || `<p class="note">No orders in this report.</p>`}
  </section>

  ${conditionals}

  <section class="block" id="book">
    <h2>The book</h2>
    <ul class="list card">
${heldRows}
    </ul>
    <details class="fold card"><summary>Not held: watchlist and avoid (${others.length})</summary>
      <ul class="list">
${otherRows}
      </ul>
    </details>
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
  // A section chip opens the section it jumps to.
  document.querySelectorAll('nav a').forEach(function (a) {
    a.addEventListener('click', function () {
      var el = document.getElementById(a.getAttribute('href').slice(1));
      if (el) el.open = true;
    });
  });
  // "Sent" ticks are a per-phone convenience, kept for this report's date only.
  var KEY = 'report-sent:${date}', sent = {};
  try { sent = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  document.querySelectorAll('.done input').forEach(function (box) {
    box.checked = !!sent[box.dataset.key];
    box.addEventListener('change', function () {
      sent[box.dataset.key] = box.checked;
      try { localStorage.setItem(KEY, JSON.stringify(sent)); } catch (e) {}
    });
  });
})();
</script>
`;

writeFileSync(outPath, html);
console.log(`${outPath} — ${orders.length} orders, ${held.length} held, ${others.length} not held, ${sections.length} sections`);

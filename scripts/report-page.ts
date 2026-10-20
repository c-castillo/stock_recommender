/**
 * Render a daily report as one self-contained HTML page for the phone.
 *
 * Reads `.whatsapp/reports/<date>.md` and `<date>.json` (what /daily-run
 * step 3 saves) and writes `<date>.html`: the orders first, then the book,
 * then the full report in collapsible sections. /daily-run publishes that
 * file as a private Claude artifact, so the report can be read and acted on
 * away from the computer. When `<date>.orders.json` exists it adds the
 * orders as one block of text to paste into the Claude app, where the Zesty
 * connector previews them and places the ones approved there.
 * No database, no network, no model call.
 *
 * Usage: pnpm exec tsx scripts/report-page.ts [YYYY-MM-DD] [out.html]
 * Without a date it takes the newest report.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blocks, esc, inline, PAGE_CSS } from "@/lib/report/page";

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

// ── The same orders as text for the Claude app ───────────────────────────────

interface BrokerOrder {
  ticker: string;
  side: "buy" | "sell";
  type: string;
  qty: number;
  limitPrice?: number | null;
  stopPrice?: number | null;
  trailPercent?: number | null;
  attachStop?: number | null;
  timeInForce?: string;
  source?: string;
  mustFill?: boolean;
  condition?: string | null;
  waitsFor?: string | null;
}

const ordersPath = join(DIR, `${date}.orders.json`);
const brokerOrders: BrokerOrder[] = existsSync(ordersPath)
  ? (JSON.parse(readFileSync(ordersPath, "utf8")).orders ?? [])
  : [];

const usd = (n?: number | null) => (n != null ? `$${n.toFixed(2)}` : "?");
const orderLine = (o: BrokerOrder) => {
  const verb = `${o.side.toUpperCase()} ${o.qty} ${o.ticker}`;
  let how: string;
  if (o.type === "trailing_stop") how = `trailing stop ${o.trailPercent}%, good till cancelled`;
  else if (o.type === "stop") how = `stop ${usd(o.stopPrice)}, good till cancelled`;
  else if (o.attachStop != null)
    how = `limit ${usd(o.limitPrice)} with a stop attached at ${usd(o.attachStop)} (one-triggers-other, good till cancelled)`;
  else how = `limit ${usd(o.limitPrice)}, ${o.timeInForce === "gtc" ? "good till cancelled" : "day"}`;
  const notes = [
    o.mustFill ? "must fill: re-price 0.5% under the last price if it has moved" : "",
    o.condition ? `condition: ${o.condition}` : "",
    o.waitsFor ? `only after ${o.waitsFor} has filled` : "",
  ].filter(Boolean);
  return `${verb}: ${how}${notes.length ? ` [${notes.join("; ")}]` : ""}`;
};

// One message the Claude app can act on with the Zesty connector. It asks for
// previews and approval one by one, never for anything to be placed outright.
const paste = brokerOrders.length
  ? [
      `Orders from my report of ${date}. Use the Zesty connector.`,
      "First read my open orders and positions, and skip any order below that already rests or no longer fits the shares I hold.",
      "Then preview each remaining one at the current price, show me every preview with its total and commission, and place only the ones I approve, one at a time. Do not place anything I have not approved in this chat.",
      "",
      ...brokerOrders.map((o, n) => `${n + 1}. ${orderLine(o)}`),
    ].join("\n")
  : "";

const pasteBlock = paste
  ? `<section class="block" id="send">
  <h2>Place them from the Claude app</h2>
  <p class="note">Copy this into a new chat in the Claude app. It previews each order at Zesty and places only what you approve there.</p>
  <textarea id="paste" class="card paste" readonly rows="${Math.min(brokerOrders.length + 6, 18)}">${esc(paste)}</textarea>
  <button id="copy" class="copy" type="button">Copy the orders</button>
</section>`
  : "";

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
  // The preflight records which session the run was written on; trust it over
  // the clock, which only knows when this page was rendered.
  const runPath = join(DIR, `${date}.run.json`);
  if (existsSync(runPath)) {
    const run = JSON.parse(readFileSync(runPath, "utf8")) as { session?: string; phase?: string };
    if (run.session && run.phase) {
      const closes = `the closes of ${new Date(`${run.session}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`;
      if (run.phase === "pre-market")
        return `Written before the open. Prices are ${closes}; stops that wait for a close were decided on them. Orders are for today's open.`;
      if (run.phase === "open")
        return `Written while the market was open. The last close is ${closes.slice(14)}; stops that wait for a close are not decided.`;
      if (run.phase === "weekend") return `Markets are closed. Prices are ${closes}. Orders are for Monday's open.`;
      return `Prices are ${closes}. Orders are for the next open.`;
    }
  }
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
    return "Written before the open. Prices are the previous session's closes; stops that wait for a close were decided on them.";
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
${PAGE_CSS}</style>

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

  ${pasteBlock}

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
  // Copy the orders. The clipboard API is often closed to an embedded page,
  // so fall back to selecting the text, which a long press can then copy.
  var copy = document.getElementById('copy'), paste = document.getElementById('paste');
  if (copy && paste) {
    copy.addEventListener('click', function () {
      paste.focus();
      paste.select();
      var done = function () { copy.textContent = 'Copied'; };
      var manual = function () {
        try { if (document.execCommand('copy')) return done(); } catch (e) {}
        copy.textContent = 'Selected: now copy';
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(paste.value).then(done, manual);
      else manual();
    });
  }
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

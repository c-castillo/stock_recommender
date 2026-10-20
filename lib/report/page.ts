/**
 * What the phone pages share: the Markdown subset the reports are written in,
 * rendered to HTML, and the page's stylesheet. Used by the US report page
 * (scripts/report-page.ts) and the Chilean one (scripts/cl/report-page.ts).
 */

// ── Markdown → HTML (the subset the reports use) ──────────────────────────────

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const inline = (s: string) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

const cells = (row: string) =>
  row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());

export function table(rows: string[]): string {
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

export function blocks(md: string): string {
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

// ── Stylesheet ──────────────────────────────────────────────────────────────

export const PAGE_CSS = `/* One column for the thumb: orders, the book, then the report folded by section. */
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
.paste { width: 100%; box-sizing: border-box; padding: 12px; font: inherit; font-size: .85rem; line-height: 1.45; color: var(--ink); resize: vertical; }
.copy { margin-top: 10px; width: 100%; padding: 12px; font: inherit; font-weight: 800; color: var(--on-accent); background: var(--yellow); border: 2px solid var(--line); border-radius: 12px; box-shadow: 4px 4px 0 var(--drop); }
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
`;

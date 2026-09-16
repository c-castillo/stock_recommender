/**
 * Per-ticker wiki: persistent markdown files that accumulate analysis history.
 * Each run appends a dated entry so future runs have full context.
 *
 * IMPORTANT: what this module loads is the model's OWN prior output, not
 * evidence. Injecting it unlabelled next to the corpus caused a self-citation
 * loop — a verdict would cite the previous session as its source, ratchet its
 * confidence up, and survive indefinitely with zero corpus support (CIEN ran
 * SELL 80→88% for 21 sessions that way). Three guards below:
 *   1. `WIKI_MAX_AGE_DAYS` — stale verdicts stop being injected at all.
 *   2. `Mentions`/`Sources` are parsed and rendered, so an unsourced verdict
 *      is visible as unsourced instead of arriving bare.
 *   3. Sources that name a prior report are flagged ⚠ self-cited.
 */

import fs from "fs";
import path from "path";

interface WikiRecommendation {
  ticker: string;
  company: string;
  action: string;
  confidence: number;
  entryPrice: string | null;
  priceTarget: string | null;
  stopLoss: string | null;
  reasoning: string;
  mentions: number;
  sources: string[];
}

const WIKI_DIR = path.join(process.cwd(), "wiki");

/**
 * A verdict older than this is not injected. The analysis window is 7 days of
 * messages; a recommendation last touched months ago is an opinion with no
 * living evidence behind it, and carrying it forward is how April SELLs ended
 * up in September prompts.
 */
const WIKI_MAX_AGE_DAYS = 45;

/** Reasoning excerpt length in the injected note. */
const REASONING_EXCERPT = 200;

/** Sources that point at the pipeline's own past output rather than the corpus. */
const SELF_CITED_RE =
  /prior (analysis|session|recommendation|sell|buy|hold|signal)|previous session|investment report|analysis history|session memory|prior report/i;

function ensureWikiDir() {
  if (!fs.existsSync(WIKI_DIR)) {
    fs.mkdirSync(WIKI_DIR, { recursive: true });
  }
}

function tickerPath(ticker: string): string {
  return path.join(WIKI_DIR, `${ticker.toUpperCase()}.md`);
}

function daysBetween(isoDate: string, now: Date): number {
  const then = Date.parse(isoDate + "T00:00:00Z");
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

// ── Read ──────────────────────────────────────────────────────────────────────

interface WikiEntry {
  date: string;
  action: string;
  confidence: number;
  entry: string;
  target: string;
  stop: string;
  reasoning: string;
  mentions: number | null;
  sources: string;
}

function parseWikiFile(content: string): { ticker: string; company: string; entries: WikiEntry[] } {
  const lines = content.split("\n");
  const headerMatch = lines[0]?.match(/^# (\S+) — (.+)$/);
  const ticker = headerMatch?.[1] ?? "?";
  const company = headerMatch?.[2] ?? "?";

  const entries: WikiEntry[] = [];

  // Split into per-entry blocks on "## YYYY-MM-DD" headings
  const sections = content.split(/(?=^## \d{4}-\d{2}-\d{2})/m);
  for (const section of sections) {
    const sLines = section.split("\n");
    const dateMatch = sLines[0]?.match(/^## (\d{4}-\d{2}-\d{2})$/);
    if (!dateMatch) continue;

    const date = dateMatch[1];
    let action = "?", confidence = 0, entry = "—", target = "—", stop = "—", reasoning = "";
    let mentions: number | null = null;
    let sources = "";

    for (const line of sLines.slice(1)) {
      const actionM = line.match(/^\*\*Action:\*\* (\w+) \(confidence: (\d+)%\)/);
      if (actionM) { action = actionM[1]; confidence = parseInt(actionM[2], 10); continue; }

      const entryM = line.match(/\*\*Entry:\*\* ([^\s|]+)/);
      if (entryM) entry = entryM[1];
      const targetM = line.match(/\*\*Target:\*\* ([^\s|]+)/);
      if (targetM) target = targetM[1];
      const stopM = line.match(/\*\*Stop:\*\* ([^\s|]+)/);
      if (stopM) stop = stopM[1];

      // Mentions/Sources are the provenance of the verdict. They used to be
      // written to disk and then dropped on read, which is precisely what let
      // unsourced verdicts pass as evidence.
      const mentionsM = line.match(/\*\*Mentions:\*\* (\d+)/);
      if (mentionsM) mentions = parseInt(mentionsM[1], 10);
      const sourcesM = line.match(/\*\*Sources:\*\* (.*)$/);
      if (sourcesM) sources = sourcesM[1].trim();

      const reasonM = line.match(/^\*\*Reasoning:\*\* (.+)$/);
      if (reasonM) reasoning = reasonM[1].slice(0, REASONING_EXCERPT);
    }

    entries.push({ date, action, confidence, entry, target, stop, reasoning, mentions, sources });
  }

  // Newest first. Same-date entries tie-break on file position (later in the
  // file = written later), so a same-day re-analysis supersedes the earlier one
  // instead of losing to it on a stable sort.
  const ordered = entries
    .map((entry, idx) => ({ entry, idx }))
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date) || b.idx - a.idx)
    .map((x) => x.entry);
  return { ticker, company, entries: ordered };
}

/**
 * Returns a compact summary of recent wiki verdicts for prompt injection —
 * the latest entry per ticker, dropping anything older than WIKI_MAX_AGE_DAYS,
 * with provenance attached and self-citation flagged.
 */
export function loadAllWikis(now: Date = new Date()): string {
  ensureWikiDir();
  const files = fs
    .readdirSync(WIKI_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (files.length === 0) return "";

  const rows: string[] = [];
  const notes: string[] = [];
  let dropped = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(WIKI_DIR, file), "utf-8").trim();
      if (!content) continue;
      const { ticker, entries } = parseWikiFile(content);
      if (entries.length === 0) continue;

      const latest = entries[0];
      const age = daysBetween(latest.date, now);
      if (age > WIKI_MAX_AGE_DAYS) { dropped++; continue; }

      const selfCited = SELF_CITED_RE.test(latest.sources);
      const provenance =
        (latest.mentions != null ? `${latest.mentions} mention(s)` : "unknown") +
        (selfCited ? " ⚠ self-cited" : "");

      rows.push(
        `${ticker}|${latest.date}|${age}d|${latest.action}|${latest.confidence}%|` +
          `${latest.entry}|${latest.target}|${latest.stop}|${provenance}`
      );

      if (latest.reasoning) {
        notes.push(
          `${ticker} (${latest.date}): ${latest.reasoning}` +
            `${latest.reasoning.length >= REASONING_EXCERPT ? "…" : ""}`
        );
      }
    } catch {
      // skip unreadable files
    }
  }

  if (rows.length === 0) return "";

  const table = [
    "## Your own prior verdicts — NOT EVIDENCE",
    "",
    "These rows are output this pipeline generated on earlier runs. They are a record of what you",
    "previously concluded, not corroboration of it. Rules:",
    "- A prior verdict may NOT be cited as a source. If nothing in this session's corpus supports it,",
    "  it has no support — say so and move toward HOLD rather than restating it.",
    "- Do NOT raise confidence on a ticker that has no new evidence this session. Absent new evidence,",
    "  confidence decays.",
    "- `Provenance` shows how many corpus mentions backed the verdict when it was written. `0 mention(s)`",
    "  or `⚠ self-cited` means it was never independently sourced.",
    `- Verdicts older than ${WIKI_MAX_AGE_DAYS} days are omitted entirely${dropped > 0 ? ` (${dropped} omitted this run)` : ""}.`,
    "",
    "Ticker|Date|Age|Action|Conf|Entry|Target|Stop|Provenance",
    "---|---|---|---|---|---|---|---|---",
    ...rows,
  ].join("\n");

  const noteBlock = notes.length
    ? "\n### Latest reasoning (also prior output, not evidence)\n" +
      notes.map((n) => `- ${n}`).join("\n")
    : "";

  return table + noteBlock + "\n";
}

// ── Write ─────────────────────────────────────────────────────────────────────

/** Appends a new dated entry to the ticker's wiki file. */
export function updateWikiEntry(
  rec: WikiRecommendation,
  date: string // ISO date string e.g. "2026-04-06"
): void {
  ensureWikiDir();
  const filePath = tickerPath(rec.ticker);

  const heading = `# ${rec.ticker} — ${rec.company}`;

  // Build the new entry block
  const entry = [
    `## ${date}`,
    "",
    `**Action:** ${rec.action} (confidence: ${rec.confidence}%)`,
    [
      rec.entryPrice ? `**Entry:** ${rec.entryPrice}` : null,
      rec.priceTarget ? `**Target:** ${rec.priceTarget}` : null,
      rec.stopLoss ? `**Stop:** ${rec.stopLoss}` : null,
    ]
      .filter(Boolean)
      .join(" | "),
    `**Mentions:** ${rec.mentions} | **Sources:** ${rec.sources.join(", ")}`,
    "",
    `**Reasoning:** ${rec.reasoning}`,
    "",
    "---",
  ]
    .filter((line) => line !== null)
    .join("\n");

  if (!fs.existsSync(filePath)) {
    // Create new file with heading
    fs.writeFileSync(filePath, `${heading}\n\n${entry}\n`, "utf-8");
  } else {
    // Append new entry after existing content
    const existing = fs.readFileSync(filePath, "utf-8");
    fs.writeFileSync(filePath, `${existing}\n${entry}\n`, "utf-8");
  }
}

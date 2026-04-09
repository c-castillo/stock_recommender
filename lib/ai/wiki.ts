/**
 * Per-ticker wiki: persistent markdown files that accumulate analysis history.
 * Each run appends a dated entry so future runs have full context.
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

function ensureWikiDir() {
  if (!fs.existsSync(WIKI_DIR)) {
    fs.mkdirSync(WIKI_DIR, { recursive: true });
  }
}

function tickerPath(ticker: string): string {
  return path.join(WIKI_DIR, `${ticker.toUpperCase()}.md`);
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

    for (const line of sLines.slice(1)) {
      const actionM = line.match(/^\*\*Action:\*\* (\w+) \(confidence: (\d+)%\)/);
      if (actionM) { action = actionM[1]; confidence = parseInt(actionM[2], 10); continue; }

      const entryM = line.match(/\*\*Entry:\*\* ([^\s|]+)/);
      if (entryM) entry = entryM[1];
      const targetM = line.match(/\*\*Target:\*\* ([^\s|]+)/);
      if (targetM) target = targetM[1];
      const stopM = line.match(/\*\*Stop:\*\* ([^\s|]+)/);
      if (stopM) stop = stopM[1];

      const reasonM = line.match(/^\*\*Reasoning:\*\* (.+)$/);
      if (reasonM) reasoning = reasonM[1].slice(0, 120);
    }

    entries.push({ date, action, confidence, entry, target, stop, reasoning });
  }

  // Newest first
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return { ticker, company, entries };
}

/**
 * Returns a compact summary of all wiki files for prompt injection.
 * Shows the last 3 entries per ticker as a table + most recent reasoning.
 * Much more token-efficient than dumping full markdown.
 */
export function loadAllWikis(): string {
  ensureWikiDir();
  const files = fs
    .readdirSync(WIKI_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (files.length === 0) return "";

  const rows: string[] = [];
  const notes: string[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(WIKI_DIR, file), "utf-8").trim();
      if (!content) continue;
      const { ticker, entries } = parseWikiFile(content);
      if (entries.length === 0) continue;

      for (const e of entries.slice(0, 3)) {
        rows.push(`${ticker}|${e.date}|${e.action}|${e.confidence}%|${e.entry}|${e.target}|${e.stop}`);
      }
      // Most recent reasoning as a one-liner note
      const latest = entries[0];
      if (latest.reasoning) {
        notes.push(`${ticker} (${latest.date}): ${latest.reasoning}${latest.reasoning.length >= 120 ? "…" : ""}`);
      }
    } catch {
      // skip unreadable files
    }
  }

  if (rows.length === 0) return "";

  const table = [
    "## Prior analysis history (last 3 runs per ticker)",
    "Ticker|Date|Action|Conf|Entry|Target|Stop",
    "---|---|---|---|---|---|---",
    ...rows,
  ].join("\n");

  const noteBlock = notes.length
    ? "\n### Latest reasoning\n" + notes.map((n) => `- ${n}`).join("\n")
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

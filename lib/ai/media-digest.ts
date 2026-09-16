/**
 * Stage 1 — media digest (model tiering: Haiku).
 *
 * Each chart image / PDF report is summarized exactly ONCE into a compact
 * structured text digest, cached in the DB (`wa_messages.media_digest`). The
 * daily synthesis call then sends those text digests instead of ~8 MB of raw
 * base64 — by far the biggest cost/latency win in the pipeline.
 *
 * Idempotent: only un-digested media inside the window is processed. Safe to
 * call both at ingestion time (sync job) and at the top of an analysis run.
 */

import fs from "fs";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { getContentForAnalysis, setMediaDigest } from "@/lib/whatsapp/db";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Cap digests produced per call so a backlog can't stall ingestion/analysis. */
const MAX_PER_RUN = 40;
/** How many media files to digest concurrently. */
const CONCURRENCY = 4;

export const digestSchema = z.object({
  ticker: z
    .string()
    .nullable()
    .describe("Primary US-equity ticker the chart/report is about, or null"),
  signal: z
    .enum(["bullish", "bearish", "neutral", "unknown"])
    .describe("Overall directional read of the chart/report"),
  levels: z
    .string()
    .describe("Key prices/levels: support, resistance, target, stop — or '—'"),
  source: z
    .string()
    .describe("What this is: chart screenshot, PDF research report, broker note, etc."),
  summary: z
    .string()
    .describe("One or two dense sentences capturing the actionable content"),
  // Dr CS trades DeMark, and the counts were being thrown away: a chart could
  // be digested as "bullish, support 115.84" while carrying an unreported Sell
  // 13 on its face. The playbook names DeMark explicitly, so the counts are
  // first-class digest output, not part of the prose summary.
  demark: z
    .string()
    .describe(
      "DeMark TD Sequential counts visible on the chart, or '—' if none. " +
        "Record every 9 and 13 with its side: numbers BELOW the bars are Buy " +
        "Setup/Countdown (bullish exhaustion of a downtrend), numbers ABOVE " +
        "are Sell (bearish). Note a perfection arrow/dot, a '+' (deferred 13), " +
        "an 'R' (recycle), counts still extending past 9, and any TDST or risk " +
        "level lines. Example: 'Sell Countdown 13 above bars, perfected; TDST " +
        "support 318'."
    ),
  // Fibonacci is the playbook's PRIMARY setup ("Fibonacci main, Demark
  // secondary"), so its levels — and above all where the grid is anchored —
  // belong in the digest rather than being lost in the prose summary.
  fibonacci: z
    .string()
    .describe(
      "Fibonacci levels drawn on the chart, or '—' if none. Give the ANCHORS " +
        "first (which swing high and low the grid is drawn from, and whether " +
        "they are cycle extremes or secondary pivots), then the plotted levels " +
        "with prices (0.236/0.382/0.5/0.618/0.786, extensions 1.618/2.618/" +
        "4.236), then which levels price actually reacted at. Note fans, arcs " +
        "or time zones if present, and whether the scale is log or arithmetic. " +
        "Example: 'Retracement anchored 2023 high 62.40 → 2025 low 28.10; " +
        "0.382=41.2, 0.5=45.2, 0.618=49.3; rejected twice at 0.382'."
    ),
});

export type MediaDigest = z.infer<typeof digestSchema>;

function isSupportedImage(mime: string | null): boolean {
  return mime != null && ["image/jpeg", "image/png", "image/webp"].includes(mime);
}

function isPdf(mime: string | null, filename: string | null): boolean {
  return mime === "application/pdf" || !!filename?.toLowerCase().endsWith(".pdf");
}

function readBase64(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath).toString("base64");
  } catch {
    return null;
  }
}

export const PROMPT =
  "You are digesting a single piece of media shared in a stock-trading WhatsApp " +
  "group. Extract only what matters for an investment decision: the ticker, the " +
  "directional signal, key price levels, the source type, and a dense one/two-line " +
  "summary. If it is not finance-related, set signal='unknown' and say so in summary.\n\n" +
  "ALWAYS check the chart for DeMark TD Sequential counts and fill the `demark` " +
  "field. These are small numbers printed against the price bars (Bloomberg and " +
  "Symbolik render the buy side green below the bars and the sell side red above; " +
  "TradingView uses blue for both, so judge by POSITION, not colour). 9 and 13 are " +
  "the counts that matter. A count BELOW the bars is a Buy Setup/Countdown and is " +
  "BULLISH — it marks a downtrend exhausting. A count ABOVE the bars is a Sell " +
  "Setup/Countdown and is BEARISH. Do not invert this. Also record: an arrow or dot " +
  "marking a perfected setup, a '+' (a deferred 13, NOT a 13), an 'R' (recycled, " +
  "the prior 13 is void), counts still running past 9 (the trend has not flipped), " +
  "and any TDST support/resistance or risk-level lines. If the chart has no DeMark " +
  "counts, set demark='—'. Never leave it blank and never guess at an unreadable " +
  "number — say which part was unreadable instead.\n\n" +
  "ALWAYS also check for Fibonacci levels and fill the `fibonacci` field. Look " +
  "for a ladder of horizontal lines labelled with ratios (0.236, 0.382, 0.5, " +
  "0.618, 0.786) or extensions (1.618, 2.618, 4.236), and for fans, arcs or " +
  "vertical time zones. Report the ANCHORS FIRST — which swing high and swing " +
  "low the grid is drawn between, and whether those are the cycle extremes or " +
  "secondary pivots — because every level depends on that choice. Then give the " +
  "levels with their prices, and say which ones price actually reacted at. Note " +
  "whether the scale is logarithmic or arithmetic. If there are no Fibonacci " +
  "levels, set fibonacci='—'.\n\n" +
  "In `summary`, when the image is a price chart, lead with the technical frame " +
  "the levels sit in: the timeframe (daily/weekly/monthly), the trend by peaks " +
  "and troughs (uptrend = higher peaks AND higher troughs; downtrend = lower " +
  "peaks AND lower troughs; otherwise sideways), price versus its moving " +
  "averages and whether those averages are themselves rising or falling, and any " +
  "momentum divergence (price at a new extreme that the oscillator does not " +
  "confirm). Name reversal patterns such as head and shoulders with their " +
  "neckline. Do not use 'Stage 1-4' labels — this framework's phases are up, " +
  "advancing, down and terminating, defined by whether momentum is rising or " +
  "falling and above or below zero.";

type DigestContent = (
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType: string }
  | { type: "file"; data: string; mediaType: string; filename: string }
)[];

/**
 * Second pass: re-read the DeMark counts on Sonnet.
 *
 * Haiku is fine for the rest of the digest but demonstrably cannot read a dense
 * TD Sequential chart. On a QQQ `demark Daily` chart from the corpus it reported
 * "green numbers below bars throughout, no active Sell Setup" — missing an
 * entire red Sell Countdown running to 13 above the bars, i.e. it inverted the
 * signal. Sonnet read the same chart correctly (both sides, the perfected-sell
 * arrow, TDST at 117.93) and flagged which digits were too crowded to resolve.
 *
 * Cost stays bounded because this only fires for charts Haiku already flagged as
 * carrying counts — roughly one chart in seventy over a 30-day window.
 * Returns Haiku's text unchanged on any failure.
 */
async function refineStudies(
  content: DigestContent,
  fallback: { demark: string; fibonacci: string }
): Promise<{ demark: string; fibonacci: string }> {
  try {
    const { object } = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: z.object({ demark: z.string(), fibonacci: z.string() }),
      maxOutputTokens: 1400,
      messages: [{ role: "user", content }],
    });
    return {
      demark: normalizeStudy(object.demark, fallback.demark),
      fibonacci: normalizeStudy(object.fibonacci, fallback.fibonacci),
    };
  } catch {
    return fallback;
  }
}

/** Collapse a "there is nothing here" answer to the empty marker. */
function normalizeStudy(value: string | undefined, fallback: string): string {
  const text = value?.trim();
  if (!text) return fallback;
  // Haiku over-triages: a text-heavy market card can be flagged as carrying a
  // study. When the second pass says there is none, record "—" so the renderer
  // omits the line instead of printing a denial as if it were a finding.
  if (
    /\bno\b[^.]{0,40}\b(demark|td sequential|count|fibonacci|fib|retracement|level|chart)\b|contains no\b/i.test(
      text
    )
  ) {
    return "—";
  }
  return text;
}

const STUDIES_PROMPT =
  "Read ONLY the DeMark TD Sequential counts on this chart. Numbers BELOW the " +
  "bars are Buy Setup/Countdown (bullish); numbers ABOVE the bars are Sell " +
  "Setup/Countdown (bearish). Bloomberg/Symbolik render buy green below and sell " +
  "red above; TradingView uses blue for both — judge by POSITION, not colour. " +
  "Report BOTH sides: it is a common and costly error to notice one side only. " +
  "Record every 9 and 13 with its side and approximate date, any perfection " +
  "arrow or dot, any '+' (deferred 13, not a 13), any 'R' (recycle, prior 13 " +
  "void), counts still running past 9 (trend has not flipped), and TDST or risk " +
  "level lines with their prices. If digits are crowded or unreadable, say so " +
  "explicitly rather than guessing. Set demark='—' if the chart has no counts.\n\n" +
  "Then read the FIBONACCI levels into `fibonacci`. Report the ANCHORS FIRST — " +
  "which swing high and swing low the grid is drawn between, and whether those " +
  "are the cycle extremes or secondary/interior pivots — because every level " +
  "depends on that choice. Then list the plotted ratios with their prices " +
  "(0.236/0.382/0.5/0.618/0.786; extensions 1.618/2.618/4.236), and say which " +
  "levels price actually reacted at (bounces, rejections, consolidation sitting " +
  "on a line). Note fans, arcs or vertical time zones, and whether the scale is " +
  "logarithmic or arithmetic. Set fibonacci='—' if there are none.\n\n" +
  "BE TERSE. Each field is at most about 400 characters — roughly three clauses: " +
  "anchors, levels, reaction. This is an index entry, not an essay. Do not " +
  "speculate about anchors that are off-screen or not visible; write 'anchors " +
  "not visible' and move on. Do not list moving averages, oscillator readings or " +
  "other overlays that are not part of the study.";

/**
 * Digest one media row. Exported so a single chart can be re-read without
 * running the whole window — ensureMediaDigests processes newest-first and caps
 * each pass, so an older chart is otherwise unreachable.
 */
export async function digestOne(row: {
  id: string;
  media_mime: string | null;
  media_filename: string | null;
  media_path: string | null;
}): Promise<boolean> {
  if (!row.media_path) return false;
  const data = readBase64(row.media_path);
  if (!data) return false;

  const isImg = isSupportedImage(row.media_mime);
  const isDoc = isPdf(row.media_mime, row.media_filename);
  if (!isImg && !isDoc) return false;

  const content = isImg
    ? [
        { type: "text" as const, text: PROMPT },
        { type: "image" as const, image: data, mediaType: row.media_mime! },
      ]
    : [
        { type: "text" as const, text: PROMPT },
        {
          type: "file" as const,
          data,
          mediaType: "application/pdf",
          filename: row.media_filename ?? "report.pdf",
        },
      ];

  try {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: digestSchema,
      maxOutputTokens: 900,
      messages: [{ role: "user", content }],
    });
    // Escalate once when Haiku says EITHER study is present, and re-read both
    // in the same Sonnet call — a chart carrying a DeMark count usually carries
    // fib levels too, and two calls would double the cost for one image.
    const digest: Record<string, unknown> = { ...object };
    const flagged = (v: unknown) => typeof v === "string" && v.trim() !== "" && v.trim() !== "—";
    if (flagged(object.demark) || flagged(object.fibonacci)) {
      const refined = await refineStudies(
        content.map((c) => (c.type === "text" ? { ...c, text: STUDIES_PROMPT } : c)) as DigestContent,
        { demark: object.demark ?? "—", fibonacci: object.fibonacci ?? "—" }
      );
      digest.demark = refined.demark;
      digest.fibonacci = refined.fibonacci;
    }
    setMediaDigest(row.id, JSON.stringify(digest));
    return true;
  } catch {
    return false; // best-effort: a failed digest is retried on the next run
  }
}

/**
 * Digests up to MAX_PER_RUN un-digested media files within the window.
 * Returns the number of digests newly produced.
 */
export async function ensureMediaDigests(sinceDaysAgo = 7): Promise<number> {
  const rows = getContentForAnalysis(sinceDaysAgo, 8000).filter(
    (r) =>
      r.media_path &&
      r.media_digest == null &&
      (isSupportedImage(r.media_mime) || isPdf(r.media_mime, r.media_filename))
  );
  if (rows.length === 0) return 0;

  const queue = rows.slice(0, MAX_PER_RUN);
  let produced = 0;

  // Simple fixed-size worker pool.
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const row = queue[cursor++];
      if (await digestOne(row)) produced++;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)
  );

  return produced;
}

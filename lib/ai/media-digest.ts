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

const digestSchema = z.object({
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

const PROMPT =
  "You are digesting a single piece of media shared in a stock-trading WhatsApp " +
  "group. Extract only what matters for an investment decision: the ticker, the " +
  "directional signal, key price levels, the source type, and a dense one/two-line " +
  "summary. If it is not finance-related, set signal='unknown' and say so in summary.";

async function digestOne(row: {
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
      maxOutputTokens: 512,
      messages: [{ role: "user", content }],
    });
    setMediaDigest(row.id, JSON.stringify(object));
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

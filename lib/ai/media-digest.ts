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
import { generateObject, generateText } from "ai";
import { z } from "zod";
import {
  digestSchema,
  PROMPT,
  STUDIES_PROMPT,
  TRANSCRIBE_PROMPT,
} from "./media-prompts";

export { digestSchema, PROMPT, type MediaDigest } from "./media-prompts";
import { getContentForAnalysis, setMediaDigest } from "@/lib/whatsapp/db";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Cap digests produced per call so a backlog can't stall ingestion/analysis. */
const MAX_PER_RUN = 40;
/** How many media files to digest concurrently. */
const CONCURRENCY = 4;

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

/**
 * Verbatim transcription of a text-heavy image, on Sonnet: the skill's own
 * testing found Haiku summarizes instead of transcribing on dense screenshots.
 * Returns null on failure so the caller can retry on a later run.
 */
async function transcribeImage(image: string, mediaType: string): Promise<string | null> {
  try {
    const { text } = await generateText({
      model: anthropic("claude-sonnet-5"),
      // Dense tables run ~2.5 chars/token, so a 6K-char screener needs ~2.5K
      // tokens before any thinking; 3000 was cutting the longest ones short.
      maxOutputTokens: 8000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: TRANSCRIBE_PROMPT },
            { type: "image", image, mediaType },
          ],
        },
      ],
    });
    return text.trim() || null;
  } catch (err) {
    console.error("[media-digest] transcription failed:", err);
    return null;
  }
}

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
    if (isImg && object.text_heavy) {
      const transcript = await transcribeImage(data, row.media_mime!);
      if (transcript) digest.transcript = transcript;
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

/**
 * Backfill transcripts for images digested before `text_heavy` existed.
 *
 * Those digests carry no flag, so they are routed by what the digest already
 * says about them: the `source`/`summary` text. Price charts, photos and memes
 * are skipped; everything that reads like a screenshot of text is transcribed.
 * The router sets text_heavy on every row it inspects, so each image is
 * considered once. Returns the number of transcripts added.
 */
export async function backfillTranscripts(
  sinceDaysAgo = 30,
  limit = 200,
  /** Re-transcribe images already routed as text-heavy (after a prompt change). */
  redo = false,
  /** With `redo`, only transcripts at least this long (0 = all). */
  redoMinChars = 0
): Promise<number> {
  const rows = getContentForAnalysis(sinceDaysAgo, 8000).filter(
    (r) => r.media_path && r.media_digest && isSupportedImage(r.media_mime)
  );
  const queue: { row: (typeof rows)[number]; digest: Record<string, unknown> }[] = [];
  for (const row of rows) {
    let digest: Record<string, unknown>;
    try {
      digest = JSON.parse(row.media_digest!);
    } catch {
      continue;
    }
    if (
      redo &&
      digest.text_heavy === true &&
      String(digest.transcript ?? "").length >= redoMinChars
    ) {
      queue.push({ row, digest });
      continue;
    }
    if (typeof digest.text_heavy === "boolean") continue; // already routed
    const textHeavy = looksTextHeavy(String(digest.source ?? ""), String(digest.summary ?? ""));
    if (!textHeavy) {
      digest.text_heavy = false;
      setMediaDigest(row.id, JSON.stringify(digest));
      continue;
    }
    queue.push({ row, digest });
  }

  let added = 0;
  let cursor = 0;
  const batch = queue.slice(0, limit);
  async function worker() {
    while (cursor < batch.length) {
      const { row, digest } = batch[cursor++];
      const data = readBase64(row.media_path!);
      if (!data) continue;
      const transcript = await transcribeImage(data, row.media_mime!);
      if (!transcript) continue; // keep the old one (or stay unrouted) and retry next run
      digest.text_heavy = true;
      digest.transcript = transcript;
      setMediaDigest(row.id, JSON.stringify(digest));
      added++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
  return added;
}

const NON_TEXTUAL = /photo|meme|entertainment|selfie|people|bicycle|lock screen/i;
/** Named text artifacts: these win even when the source also mentions a chart
 *  ("broker note with embedded chart"). */
const TEXT_ARTIFACT = /table|screener|watchlist|listing|\blist\b|note|report|research|article|news|headline|tweet|\bpost\b|message|chat|transcript|text|profile|holdings|document|excerpt|commentary|calendar|sheet|expiration/i;
const CHART = /\bchart\b|candlestick|heatmap|graph|intraday|profile chart/i;
const SCREENSHOT = /screenshot|screen|snapshot|terminal|panel|dashboard|data/i;

function looksTextHeavy(source: string, summary: string): boolean {
  if (NON_TEXTUAL.test(source)) return false;
  if (TEXT_ARTIFACT.test(source)) return true;
  if (CHART.test(source)) return false; // a price chart, even as a "screenshot"
  return SCREENSHOT.test(source) || /\b(tweet|headline|article|table)\b/i.test(summary);
}

/**
 * Loads downloaded WhatsApp content and converts it into
 * Anthropic content blocks ready to be sent to Claude.
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { getContentForAnalysis, type MessageForAnalysis } from "@/lib/whatsapp/db";

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_TEXT_MESSAGES = 2500;
const MAX_IMAGES = 15;
const MAX_DOCUMENTS = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024;           // 2 MB per file
// Total base64 budget for all media combined (~8 MB raw ≈ 11 MB base64 on the wire)
const MAX_TOTAL_MEDIA_BYTES = 8 * 1024 * 1024;

// ── Types ─────────────────────────────────────────────────────────────────────

type ContentBlock = Anthropic.ImageBlockParam | Anthropic.TextBlockParam;

// DocumentBlockParam is not in the main union in older SDK versions;
// we cast it to avoid TS noise while staying correct at runtime.
interface DocumentBlock {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
  title?: string;
}

export interface LoadedContent {
  blocks: (ContentBlock | DocumentBlock)[];
  stats: {
    textMessages: number;
    images: number;
    documents: number;
    groups: string[];
  };
}

// ── Relevance filter ──────────────────────────────────────────────────────────

// Patterns that strongly suggest financial relevance — keep these always
const FINANCIAL_RE =
  /\b([A-Z]{1,5})\b|\$[0-9]|%|precio|target|stop|soporte|resistencia|comprar?|vender?|invertir|accion|bolsa|mercado|etf|fondo|divisa|dolar|peso|bitcoin|crypto|chart|grafico|reporte|earnings|resultado|dividendo|ticker|long|short|bull|bear|fibonacci|ma\s*\d{2,3}|mm\s*\d{2,3}|análisis|analisis|pd[fF]|informe|recomenda/i;

// Patterns that mark a message as clearly non-relevant
const IRRELEVANT_RE =
  /^[\s\p{Emoji}\u200d\ufe0f]*$/u; // emoji/whitespace only

const GREETING_RE =
  /^(hola|buenas?(\s+(días?|tardes?|noches?))?|saludos?|buenos días?|buen[ao]s|hi|hello|hey|gracias|de nada|ok|okay|si|sí|no|claro|exacto|correcto|verdad|jaja+|jeje+|lol|xd|😂|👍|👋|🙌|🤣|feliz|bienvenid|hasta luego|nos vemos|ciao|adios|adiós|chao|que tal|como están?|como van?|buen fin|buen finde)[\s!.,?]*$/i;

/**
 * Returns true if the message body is likely relevant to investment analysis.
 * Short social messages (greetings, laughter, emoji-only, off-topic) are excluded.
 */
function isRelevantMessage(body: string): boolean {
  const trimmed = body.trim();

  // Discard empty
  if (!trimmed) return false;

  // Keep anything explicitly financial regardless of length
  if (FINANCIAL_RE.test(trimmed)) return true;

  // Discard emoji/whitespace-only
  if (IRRELEVANT_RE.test(trimmed)) return false;

  // Discard common greetings / social filler
  if (GREETING_RE.test(trimmed)) return false;

  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString("es-CL", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function readFileBase64(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath).toString("base64");
  } catch {
    return null;
  }
}

function isSupportedImageMime(
  mime: string
): mime is "image/jpeg" | "image/png" | "image/webp" {
  // Exclude image/gif (animated GIFs) — not useful for chart analysis
  return ["image/jpeg", "image/png", "image/webp"].includes(mime);
}

// ── Main export ───────────────────────────────────────────────────────────────

export function loadContent(): LoadedContent {
  const rows = getContentForAnalysis(7, MAX_TEXT_MESSAGES);

  // Separate text-only rows from media rows; discard non-relevant messages
  const textRows = rows.filter((r) => r.body && isRelevantMessage(r.body));
  const imageRows = rows.filter(
    (r) =>
      r.media_type === "image" &&
      r.media_path &&
      isSupportedImageMime(r.media_mime ?? "")
  );
  const docRows = rows.filter(
    (r) =>
      r.media_type === "document" &&
      r.media_path &&
      (r.media_mime === "application/pdf" ||
        r.media_filename?.toLowerCase().endsWith(".pdf"))
  );

  const groupNames = [...new Set(rows.map((r) => r.group_name))];
  const blocks: (ContentBlock | DocumentBlock)[] = [];

  // ── 1. Text messages ────────────────────────────────────────────────────────
  if (textRows.length > 0) {
    // Group by group name, newest first
    const byGroup = new Map<string, MessageForAnalysis[]>();
    for (const r of textRows) {
      const g = byGroup.get(r.group_name) ?? [];
      g.push(r);
      byGroup.set(r.group_name, g);
    }

    let text = `# Mensajes de WhatsApp — últimos 7 días (${textRows.length} mensajes)\n\n`;
    for (const [groupName, msgs] of byGroup) {
      text += `## ${groupName}\n`;
      // Show oldest first within each group so context reads naturally
      for (const m of [...msgs].reverse()) {
        text += `[${formatTs(m.ts)}] ${m.sender ?? "?"}: ${m.body}\n`;
      }
      text += "\n";
    }

    blocks.push({ type: "text", text });
  }

  // ── 2. Images ───────────────────────────────────────────────────────────────
  let imageCount = 0;
  let totalMediaBytes = 0;
  for (const r of imageRows) {
    if (imageCount >= MAX_IMAGES || totalMediaBytes >= MAX_TOTAL_MEDIA_BYTES) break;
    const data = readFileBase64(r.media_path!);
    if (!data) continue;
    totalMediaBytes += Math.ceil(data.length * 0.75); // base64 → raw bytes
    if (totalMediaBytes > MAX_TOTAL_MEDIA_BYTES) break;

    const mime = r.media_mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: mime, data },
    });
    blocks.push({
      type: "text",
      text: `↑ Imagen compartida en "${r.group_name}" el ${formatTs(r.ts)}${r.media_filename ? ` — ${r.media_filename}` : ""}`,
    });
    imageCount++;
  }

  // ── 3. PDF documents ────────────────────────────────────────────────────────
  let docCount = 0;
  for (const r of docRows) {
    if (docCount >= MAX_DOCUMENTS || totalMediaBytes >= MAX_TOTAL_MEDIA_BYTES) break;
    const data = readFileBase64(r.media_path!);
    if (!data) continue;
    totalMediaBytes += Math.ceil(data.length * 0.75);
    if (totalMediaBytes > MAX_TOTAL_MEDIA_BYTES) break;

    blocks.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data },
      title: r.media_filename ?? path.basename(r.media_path!),
    });
    blocks.push({
      type: "text",
      text: `↑ Documento PDF compartido en "${r.group_name}" el ${formatTs(r.ts)}${r.media_filename ? ` — ${r.media_filename}` : ""}`,
    });
    docCount++;
  }

  return {
    blocks,
    stats: {
      textMessages: textRows.length,
      images: imageCount,
      documents: docCount,
      groups: groupNames,
    },
  };
}

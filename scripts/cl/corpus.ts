/**
 * The Chilean sources' corpus — the IPSA WhatsApp group and the imported
 * Dividendos Chile Telegram group — read and digested without joining the US
 * scope.
 *
 *   pnpm exec tsx scripts/cl/corpus.ts status
 *   pnpm exec tsx scripts/cl/corpus.ts pending-media [--days 120] [--limit 30]
 *   pnpm exec tsx scripts/cl/corpus.ts save-digest <id> @digest.json
 *   pnpm exec tsx scripts/cl/corpus.ts search <text> [--days 180]
 *
 * The MCP server's `pending_media` and `save_media_digest` only see the US
 * groups, so the Chilean digester uses this instead: the same rules, the same
 * column, so a file is read once.
 */
import { existsSync, readFileSync } from "node:fs";
import { CL_SOURCES, CL_TELEGRAM_JID } from "@/lib/cl/config";
import { digestSchema, PROMPT, STUDIES_PROMPT, TRANSCRIBE_PROMPT } from "@/lib/ai/media-prompts";
import { getGroupContent, isMainAnalyst, listGroupJidsByName, setMediaDigest } from "@/lib/whatsapp/db";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const jids = listGroupJidsByName(CL_SOURCES);
if (jids.length === 0) {
  console.error(`None of ${CL_SOURCES.join(", ")} is in the database: refresh the WhatsApp groups / import the Telegram export.`);
  process.exit(2);
}
/** The Telegram group is busy and its photos are mostly screenshots of
 *  announcements already in the text: only its last 30 days are digested. */
const TELEGRAM_MEDIA_DAYS = 30;
const inMediaWindow = (r: { jid: string; ts: number }) =>
  r.jid !== CL_TELEGRAM_JID || r.ts >= Date.now() / 1000 - TELEGRAM_MEDIA_DAYS * 86400;
const stamp = (ts: number) =>
  new Date(ts * 1000).toLocaleString("es-CL", { timeZone: "America/Santiago", dateStyle: "short", timeStyle: "short" });
const who = (s: string | null) => (isMainAnalyst(s) ? "MAIN ANALYST" : (s ?? "?"));
const isMedia = (r: { media_type: string | null }) => r.media_type === "image" || r.media_type === "document";

if (cmd === "status") {
  for (const jid of jids) {
    const rows = getGroupContent([jid], 3650, 100000);
    const newest = rows[0];
    const media = rows.filter(isMedia);
    const pending = media.filter((r) => r.media_digest == null && r.media_path && existsSync(r.media_path) && inMediaWindow(r));
    const missing = media.filter((r) => !r.media_path || !existsSync(r.media_path));
    const age = newest ? Math.max(0, Date.now() / 1000 - newest.ts) / 86400 : Infinity;
    console.log(`${newest?.group_name ?? jid}: ${rows.length} messages, newest ${newest ? stamp(newest.ts) : "none"} (${age.toFixed(1)} days old). ` +
      `Media: ${media.length} files, ${media.filter((r) => r.media_digest != null).length} digested, ` +
      `${pending.length} awaiting a digest${jid === CL_TELEGRAM_JID ? ` (last ${TELEGRAM_MEDIA_DAYS} days)` : ""}, ${missing.length} not downloaded.`);
  }
} else if (cmd === "pending-media") {
  const rows = getGroupContent(jids, opt("days", 120), 100000)
    .filter((r) => isMedia(r) && r.media_digest == null && r.media_path && existsSync(r.media_path) && inMediaWindow(r));
  if (rows.length === 0) {
    console.log("No undigested media.");
    process.exit(0);
  }
  const batch = rows.slice(0, opt("limit", 30));
  console.log(`## ${rows.length} file(s) awaiting a digest${rows.length > batch.length ? ` (newest ${batch.length})` : ""}\n`);
  for (const r of batch) {
    const caption = r.body && !/^\[(image|document|video|audio)\]$/.test(r.body) ? `\n  caption: ${r.body.replace(/\s+/g, " ").slice(0, 300)}` : "";
    console.log(`- id: ${r.id}\n  path: ${r.media_path}\n  ${r.media_type} (${r.media_mime ?? "?"}) · ${stamp(r.ts)} · "${r.group_name}" · ${who(r.sender)}${caption}`);
  }
  console.log(
    "\n## How to digest each file\n" +
      "These files come from the Chilean sources: `ticker` is the Santiago ticker as it trades " +
      "(COPEC, ANDINA-B, SQM-B), or an index or ETF name, not a US ticker.\n\n" +
      PROMPT +
      "\n\nFor charts carrying DeMark or Fibonacci studies, read them with the technical-analysis, " +
      "fibonacci-charts and demark-charts skills and follow these rules:\n" +
      STUDIES_PROMPT +
      "\n\nSet text_heavy=true when the file's information is mostly text or numbers and fill " +
      "`transcript` following these rules:\n" +
      TRANSCRIBE_PROMPT +
      "\n\nSave each with: pnpm exec tsx scripts/cl/corpus.ts save-digest <id> @<file.json>, where the " +
      "JSON has the digest fields (ticker, signal, levels, source, summary, demark, fibonacci, " +
      "text_heavy) and `transcript` when text_heavy is true."
  );
} else if (cmd === "save-digest") {
  const [, id, src] = args;
  if (!id || !src) throw new Error("usage: save-digest <id> @digest.json");
  const raw = JSON.parse(src.startsWith("@") ? readFileSync(src.slice(1), "utf8") : src);
  const row = getGroupContent(jids, 3650, 100000).find((r) => r.id === id);
  if (!row) throw new Error(`No message with id ${id} in ${CL_SOURCES.join(" / ")}`);
  const { transcript, ...fields } = raw;
  const digest = digestSchema.parse(fields);
  const stored: Record<string, unknown> = { ...digest, digested_by: "claude-code" };
  if (digest.text_heavy && typeof transcript === "string" && transcript.trim()) stored.transcript = transcript.trim();
  setMediaDigest(id, JSON.stringify(stored));
  console.log(`Saved digest for ${id}${stored.transcript ? " (with transcript)" : ""}.`);
} else if (cmd === "search" && args[1]) {
  const needle = args[1].toLowerCase();
  const hits = getGroupContent(jids, opt("days", 180), 100000).filter((r) =>
    `${r.body ?? ""} ${r.media_digest ?? ""}`.toLowerCase().includes(needle)
  );
  for (const r of hits.slice(0, 80)) console.log(`[${stamp(r.ts)}] ${r.group_name} · ${who(r.sender)}: ${r.body}`);
  console.log(`${hits.length} match(es).`);
} else {
  console.error("usage: corpus.ts status | pending-media | save-digest <id> @file.json | search <text>");
  process.exit(2);
}

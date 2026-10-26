/**
 * Import Telegram Desktop HTML exports of the Chilean book's Telegram sources
 * (CL_TELEGRAM_CHATS) into the corpus.
 *
 *   pnpm exec tsx scripts/cl/telegram.ts [<ChatExport folder>]
 *
 * Without a folder it imports, for each known chat, the newest
 * `~/Downloads/Telegram Desktop/ChatExport_*` whose header names that chat;
 * exports of other chats are listed and left alone. A folder given by hand is
 * imported only if its chat is known (exit 4 otherwise): Telegram numbers
 * messages per chat, so each chat has its own pseudo-jid and ids, and one can
 * never overwrite another. Exit 2 when no export of any known chat is found.
 * The pseudo-groups are never selected, so the US analysis never reads them;
 * the Chilean corpus and bundle read them by name. Photos are copied into
 * `.whatsapp/media/<jid>/` so the export can be deleted. Re-importing the same
 * or a newer export is idempotent: ids are the export's own message ids.
 *
 * The export is untrusted input: it is parsed as text, nothing in it is run.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CL_TELEGRAM_CHATS, type ClTelegramChat } from "@/lib/cl/config";
import { countAllMessages, insertMessages, upsertGroup, type MessageRow } from "@/lib/whatsapp/db";

/** The chat's name, from the first page's header. */
function chatName(dir: string): string | null {
  const html = readFileSync(join(dir, "messages.html"), "utf8");
  const m = /<div class="text bold">\s*([\s\S]*?)\s*<\/div>/.exec(html);
  return m ? m[1].trim() : null;
}

/** The newest export of each known chat in ~/Downloads/Telegram Desktop. */
function newestExports(): [string, ClTelegramChat][] {
  const base = join(homedir(), "Downloads", "Telegram Desktop");
  if (!existsSync(base)) return [];
  const dirs = readdirSync(base)
    .filter((d) => d.startsWith("ChatExport_"))
    .map((d) => join(base, d))
    .filter((d) => existsSync(join(d, "messages.html")))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  for (const d of dirs.filter((d) => !CL_TELEGRAM_CHATS.some((c) => c.chat === chatName(d))))
    console.log(`Skipped ${d}: the chat "${chatName(d) ?? "?"}" is not a Chilean source.`);
  return CL_TELEGRAM_CHATS.flatMap((c) => {
    const d = dirs.filter((x) => chatName(x) === c.chat).at(-1);
    return d ? [[d, c] as [string, ClTelegramChat]] : [];
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", hellip: "…", mdash: "—", ndash: "–" };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1] === "x" ? 2 : 1), e[1] === "x" ? 16 : 10)) : (ENTITIES[e.toLowerCase()] ?? m)
  );

/** The visible text of an HTML fragment: line breaks kept, links as "text (url)". */
function textOf(html: string): string {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<a [^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, label) =>
        label.replace(/<[^>]+>/g, "").trim() === url ? url : `${label} (${url})`
      )
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "23.12.2025 17:10:51 UTC-04:00" → unix seconds. */
function tsOf(title: string): number | null {
  const m = /(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2}) UTC([+-]\d{2}):(\d{2})/.exec(title);
  if (!m) return null;
  return Math.floor(Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8]}`) / 1000);
}

/** The div whose opening tag starts at `start`, through its matching close. */
function divAt(html: string, start: number): string {
  let depth = 0;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + 6);
  }
  return html.slice(start);
}

function divsOf(html: string, cls: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<div class="${cls}"`, "g");
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(divAt(html, m.index));
  return out;
}
const inner = (div: string) => div.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");

function importExport(dir: string, chat: ClTelegramChat): void {
  const pages = readdirSync(dir)
    .filter((f) => /^messages\d*\.html$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 1) - Number(b.match(/\d+/)?.[0] ?? 1));
  const mediaDir = join(process.cwd(), ".whatsapp", "media", chat.jid.replace(":", "-"));
  mkdirSync(mediaDir, { recursive: true });

  const rows: MessageRow[] = [];
  let sender: string | null = null;
  let photos = 0;
  for (const page of pages) {
    const html = readFileSync(join(dir, page), "utf8");
    for (const m of html.matchAll(/<div class="message default clearfix( joined)?" id="message(\d+)">/g)) {
      const block = divAt(html, m.index!);
      const id = m[2];
      const ts = tsOf(/class="pull_right date details" title="([^"]+)"/.exec(block)?.[1] ?? "");
      if (ts == null) continue;
      const fwd = divsOf(block, "forwarded body")[0] ?? "";
      const own = fwd ? block.replace(fwd, "") : block;
      const name = divsOf(own, "from_name")[0];
      if (name) sender = textOf(inner(name)) || sender;

      const parts: string[] = [];
      const reply = /GoToMessage\((\d+)\)/.exec(own)?.[1];
      if (reply) parts.push(`↪ reply to #${reply}`);
      if (fwd) {
        const who = textOf(inner(divsOf(fwd, "from_name")[0] ?? "")).replace(/\s+\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/, "");
        parts.push(`[forwarded from ${who || "?"}]`);
      }
      for (const t of divsOf(block, "text")) parts.push(textOf(inner(t)));
      for (const f of divsOf(block, "media clearfix pull_left media_file"))
        parts.push(`[file: ${textOf(inner(divsOf(f, "title bold")[0] ?? ""))} — not in the export]`);

      const photo = /<a class="photo_wrap[^"]*" href="(photos\/[^"]+)"/.exec(block)?.[1];
      let mediaPath: string | null = null;
      if (photo && existsSync(join(dir, photo))) {
        mediaPath = join(mediaDir, photo.slice("photos/".length));
        if (!existsSync(mediaPath)) copyFileSync(join(dir, photo), mediaPath);
        photos++;
      }
      const body = parts.filter(Boolean).join("\n") || (mediaPath ? "[image]" : "");
      if (!body) continue;
      rows.push({
        id: `${chat.jid}:${id}`,
        jid: chat.jid,
        sender,
        body,
        ts,
        media_type: mediaPath ? "image" : null,
        media_mime: mediaPath ? "image/jpeg" : null,
        media_filename: mediaPath ? photo!.slice("photos/".length) : null,
        media_path: mediaPath,
      });
    }
  }

  upsertGroup(chat.jid, chat.group);
  const before = countAllMessages(chat.jid);
  insertMessages(rows);
  const after = countAllMessages(chat.jid);
  const span = rows.length ? `${new Date(rows[0].ts * 1000).toISOString().slice(0, 10)} → ${new Date(rows.at(-1)!.ts * 1000).toISOString().slice(0, 10)}` : "empty";
  console.log(`${chat.group}: ${rows.length} messages parsed (${span}), ${photos} photos; stored ${before} → ${after} (+${after - before}).`);
}

let jobs: [string, ClTelegramChat][];
if (process.argv[2]) {
  const dir = process.argv[2];
  const chat = existsSync(join(dir, "messages.html")) ? CL_TELEGRAM_CHATS.find((c) => c.chat === chatName(dir)) : undefined;
  if (!chat) {
    console.error(`${dir} is the chat "${existsSync(join(dir, "messages.html")) ? (chatName(dir) ?? "?") : "?"}", not one of ${CL_TELEGRAM_CHATS.map((c) => `"${c.chat}"`).join(", ")}: not imported.`);
    process.exit(4);
  }
  jobs = [[dir, chat]];
} else {
  jobs = newestExports();
}
if (!jobs.length) {
  console.error("No Telegram export of a Chilean source found: put it in ~/Downloads/Telegram Desktop/.");
  process.exit(2);
}
for (const [dir, chat] of jobs) importExport(dir, chat);
if (!process.argv[2])
  for (const c of CL_TELEGRAM_CHATS.filter((c) => !jobs.some(([, j]) => j === c)))
    console.log(`${c.group}: no export found; the run goes on with what is stored.`);

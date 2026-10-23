/**
 * Sync the Chilean book's Telegram sources (CL_TELEGRAM_CHATS: Dividendos
 * Chile, Hablemos de Chile) straight from Telegram, as the user's account —
 * no export needed.
 *
 *   pnpm exec tsx scripts/cl/telegram-sync.mts [--days 30] [--media-days 30]
 *
 * Each chat is found among the account's dialogs by the same name the export
 * importer matches, and read from the newest stored message onwards (from
 * `--days` back when nothing is stored, or always with `--backfill`). Ids are
 * Telegram's own message ids, the ones the export carries too, so rows
 * imported from an export and rows synced here are the same rows. Photos and
 * PDFs of the last `--media-days` are downloaded to `.whatsapp/media/<jid>/`.
 *
 * Read-only: it never sends, and reads only the two known chats (no DMs).
 * Exit 3 when there is no session (run scripts/cl/telegram-login.mts), 2 when
 * neither chat is in the account's dialogs.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api } from "telegram";
import { CL_TELEGRAM_CHATS, type ClTelegramChat } from "@/lib/cl/config";
import { makeClient, SESSION_FILE } from "@/lib/cl/telegram-client";
import { countAllMessages, getNewestMessage, insertMessages, upsertGroup, type MessageRow } from "@/lib/whatsapp/db";

const args = process.argv.slice(2);
const opt = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const DAYS = opt("days", 30);
const MEDIA_DAYS = opt("media-days", 30);
const BACKFILL = args.includes("--backfill");
const MAX_PDF = 20 * 1024 * 1024;
const now = Math.floor(Date.now() / 1000);

if (!existsSync(SESSION_FILE)) {
  console.error("No Telegram session: log in with scripts/cl/telegram-login.mts.");
  process.exit(3);
}

const nameOf = (e: unknown): string | null => {
  if (e instanceof Api.User) return [e.firstName, e.lastName].filter(Boolean).join(" ") || (e.username ?? null);
  if (e instanceof Api.Channel || e instanceof Api.Chat) return e.title;
  return null;
};

/** The text with each hidden link written out as "label (url)", like the export importer. */
function textOf(msg: Api.Message): string {
  let text = msg.message ?? "";
  const links = (msg.entities ?? []).filter((e): e is Api.MessageEntityTextUrl => e instanceof Api.MessageEntityTextUrl);
  for (const e of links.sort((a, b) => b.offset - a.offset)) {
    const end = e.offset + e.length;
    text = `${text.slice(0, end)} (${e.url})${text.slice(end)}`;
  }
  return text.trim();
}

async function syncChat(client: ReturnType<typeof makeClient>, entity: Api.TypeEntityLike, chat: ClTelegramChat): Promise<void> {
  const mediaDir = join(process.cwd(), ".whatsapp", "media", chat.jid.replace(":", "-"));
  mkdirSync(mediaDir, { recursive: true });
  const newest = getNewestMessage(chat.jid);
  const minId = !BACKFILL && newest ? Number(newest.id.split(":").at(-1)) : 0;
  const since = now - DAYS * 86400;

  const rows: MessageRow[] = [];
  let files = 0;
  for await (const msg of client.iterMessages(entity, { minId })) {
    if (!(msg instanceof Api.Message)) continue;
    if (!minId && msg.date < since) break;
    const parts: string[] = [];
    const reply = msg.replyTo?.replyToMsgId;
    if (reply) parts.push(`↪ reply to #${reply}`);
    if (msg.fwdFrom) {
      const who = msg.fwdFrom.fromName ?? nameOf(await msg.forward?.getSender().catch(() => undefined)) ?? nameOf(await msg.forward?.getChat().catch(() => undefined));
      parts.push(`[forwarded from ${who ?? "?"}]`);
    }
    const text = textOf(msg);
    if (text) parts.push(text);

    let media: Pick<MessageRow, "media_type" | "media_mime" | "media_filename" | "media_path"> = {};
    const recent = msg.date >= now - MEDIA_DAYS * 86400;
    if (msg.photo) {
      const file = `${msg.id}.jpg`;
      const path = join(mediaDir, file);
      if (recent && !existsSync(path)) writeFileSync(path, (await client.downloadMedia(msg, {})) as Buffer);
      if (existsSync(path)) {
        media = { media_type: "image", media_mime: "image/jpeg", media_filename: file, media_path: path };
        files++;
      }
    } else if (msg.document) {
      const doc = msg.document as Api.Document;
      const name = doc.attributes.find((a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename)?.fileName ?? `${msg.id}`;
      const file = `${msg.id}-${name.replace(/[/\\]/g, "_")}`;
      const path = join(mediaDir, file);
      if (doc.mimeType === "application/pdf" && Number(doc.size) <= MAX_PDF) {
        if (recent && !existsSync(path)) writeFileSync(path, (await client.downloadMedia(msg, {})) as Buffer);
        if (existsSync(path)) {
          media = { media_type: "document", media_mime: doc.mimeType, media_filename: file, media_path: path };
          files++;
        }
      }
      if (!media.media_path) parts.push(`[file: ${name} — not downloaded]`);
    }

    const body = parts.join("\n") || (media.media_type === "image" ? "[image]" : media.media_type ? "[document]" : "");
    if (!body) continue;
    rows.push({
      id: `${chat.jid}:${msg.id}`,
      jid: chat.jid,
      sender: nameOf(await msg.getSender().catch(() => undefined)) ?? msg.postAuthor ?? null,
      body,
      ts: msg.date,
      ...media,
    });
  }

  upsertGroup(chat.jid, chat.group);
  const before = countAllMessages(chat.jid);
  insertMessages(rows);
  const after = countAllMessages(chat.jid);
  const last = getNewestMessage(chat.jid);
  console.log(
    `${chat.group}: ${rows.length} messages fetched${minId ? ` after #${minId}` : ` (last ${DAYS} days)`}, ${files} files; ` +
      `stored ${before} → ${after} (+${after - before}); newest ${last ? new Date(last.ts * 1000).toISOString().slice(0, 10) : "none"}.`
  );
}

const client = makeClient();
await client.connect();
if (!(await client.checkAuthorization())) {
  console.error("The Telegram session is no longer valid: log in again with scripts/cl/telegram-login.mts.");
  await client.disconnect();
  process.exit(3);
}
const dialogs = await client.getDialogs({});
let found = 0;
for (const chat of CL_TELEGRAM_CHATS) {
  const d = dialogs.find((x) => x.title === chat.chat);
  if (!d?.entity) {
    console.log(`${chat.group}: "${chat.chat}" is not among the account's chats; the run goes on with what is stored.`);
    continue;
  }
  found++;
  await syncChat(client, d.entity, chat);
}
await client.disconnect();
process.exit(found ? 0 : 2);

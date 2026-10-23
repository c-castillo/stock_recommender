/**
 * The Telegram user client the Chilean sync reads through (GramJS, MTProto).
 *
 * It logs in as the user's own account: the API id and hash from
 * my.telegram.org live in .env.local, and the session — which grants the
 * whole account — in `.whatsapp/cl/telegram.session` (git-ignored, mode 600).
 * Nothing here sends a message; only the two known chats are ever read.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CL_DIR } from "@/lib/cl/config";

export const SESSION_FILE = join(CL_DIR, "telegram.session");

export function credentials(): { apiId: number; apiHash: string } {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (!apiId || !apiHash) throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env.local (my.telegram.org/apps).");
  return { apiId, apiHash };
}

export function makeClient(session = existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, "utf8").trim() : ""): TelegramClient {
  const { apiId, apiHash } = credentials();
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
  client.setLogLevel("error" as never);
  return client;
}

export function saveSession(client: TelegramClient, file = SESSION_FILE): void {
  mkdirSync(CL_DIR, { recursive: true });
  writeFileSync(file, String(client.session.save()), { mode: 0o600 });
  chmodSync(file, 0o600);
}

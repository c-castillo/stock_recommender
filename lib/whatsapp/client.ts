/**
 * WhatsApp client singleton powered by whatsapp-web.js.
 *
 * Keeps a single Client open for the lifetime of the Node.js process.
 * Authenticates via QR code using LocalAuth (session persisted to disk).
 * All received group messages are saved to the SQLite database; media is
 * downloaded to disk immediately.
 */

import { Client, LocalAuth, type Message } from "whatsapp-web.js";
import path from "path";
import os from "os";
import { upsertGroups, insertMessage, listGroups } from "./db";
import { downloadAndSave } from "./media";

// ── Paths ─────────────────────────────────────────────────────────────────────

// Session (Puppeteer user data dir) lives OUTSIDE the project so Turbopack's
// file watcher never encounters Chromium's Unix socket files.
const SESSION_DIR = path.join(os.homedir(), ".stock-recommender-wa");

// ── State ─────────────────────────────────────────────────────────────────────

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "qr_ready"
  | "connected";

interface State {
  status: ConnectionStatus;
  qr: string | null;
  error: string | null;
}

let state: State = { status: "disconnected", qr: null, error: null };
let wClient: Client | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

export function getStatus(): Readonly<State> {
  return state;
}

export function getClient(): Client | null {
  return wClient;
}

export function getGroups() {
  return listGroups();
}

/** Start the WhatsApp connection. Safe to call multiple times. */
export async function connect(): Promise<void> {
  if (wClient) return;

  state = { status: "connecting", qr: null, error: null };

  wClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  wClient.on("qr", (qr) => {
    // Store raw QR string — status/route.ts converts it to a data URL
    state = { status: "qr_ready", qr, error: null };
  });

  wClient.on("ready", async () => {
    state = { status: "connected", qr: null, error: null };
    await refreshGroups();
  });

  wClient.on("auth_failure", (msg) => {
    state = { status: "disconnected", qr: null, error: `Auth failure: ${msg}` };
    wClient = null;
  });

  wClient.on("disconnected", (reason) => {
    state = {
      status: "disconnected",
      qr: null,
      error: `Disconnected: ${reason}`,
    };
    wClient = null;
  });

  wClient.on("message_create", async (msg) => {
    if (!msg.from.endsWith("@g.us")) return;
    await processMessage(msg);
  });

  // initialize() blocks until auth is complete; run it in the background
  // so connect() returns immediately and state updates via events.
  wClient.initialize().catch((err) => {
    state = { status: "disconnected", qr: null, error: String(err) };
    wClient = null;
  });
}

/** Disconnect and destroy the browser. Does not wipe the session. */
export function disconnect(): void {
  try {
    wClient?.destroy();
  } catch {
    /* ignore */
  }
  wClient = null;
  state = { status: "disconnected", qr: null, error: null };
}

/** Re-fetch all groups from WhatsApp and update the DB. */
export async function refreshGroups(): Promise<void> {
  if (!wClient || state.status !== "connected") return;
  try {
    const chats = await wClient.getChats();
    upsertGroups(
      chats
        .filter((c) => c.isGroup)
        .map((c) => ({ jid: c.id._serialized, name: c.name }))
    );
  } catch {
    /* non-fatal */
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function processMessage(msg: Message) {
  const jid = msg.from;
  const id = msg.id._serialized;
  const ts = msg.timestamp;
  const sender = msg.author ?? msg.from;
  const body = msg.body || null;

  let mediaResult = null;
  if (msg.hasMedia) {
    try {
      mediaResult = await downloadAndSave(msg);
    } catch {
      /* ignore — save message without media */
    }
  }

  // Drop pure system messages (no body, no media type)
  if (!body && !msg.hasMedia) return;

  const effectiveBody =
    body ?? (mediaResult ? `[${mediaResult.media_type}]` : `[${msg.type}]`);

  try {
    insertMessage({
      id,
      jid,
      sender,
      body: effectiveBody,
      ts,
      media_type: mediaResult?.media_type ?? null,
      media_mime: mediaResult?.media_mime ?? null,
      media_filename: mediaResult?.media_filename ?? null,
      media_path: mediaResult?.media_path ?? null,
    });
  } catch {
    /* duplicate — ignore */
  }
}

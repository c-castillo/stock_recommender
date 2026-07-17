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
import fs from "fs";
import { upsertGroups, insertMessage, listGroups } from "./db";
import { downloadAndSave } from "./media";

// ── Paths ─────────────────────────────────────────────────────────────────────

// Session (Puppeteer user data dir) lives OUTSIDE the project so Turbopack's
// file watcher never encounters Chromium's Unix socket files.
const SESSION_DIR =
  process.env.NODE_ENV === "production"
    ? "/tmp/.stock-recommender-wa"
    : path.join(os.homedir(), ".stock-recommender-wa");

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

// Pin the connection on globalThis so it survives Next.js dev hot-reloads.
// Module-level `let`s are reset to their initializers whenever Turbopack
// re-evaluates this module (e.g. after editing any file in its import graph),
// which would orphan a live Puppeteer client: the recompiled route sees
// wClient = null ("not connected") while older routes still hold the real one.
interface WaGlobal {
  state: State;
  wClient: Client | null;
}
const g = globalThis as unknown as { __waClient?: WaGlobal };
g.__waClient ??= { state: { status: "disconnected", qr: null, error: null }, wClient: null };
const store = g.__waClient;

// ── Public API ────────────────────────────────────────────────────────────────

export function getStatus(): Readonly<State> {
  return store.state;
}

export function getClient(): Client | null {
  return store.wClient;
}

export function getGroups() {
  return listGroups();
}

/** Start the WhatsApp connection. Safe to call multiple times. */
export async function connect(): Promise<void> {
  if (store.wClient) return;

  store.state = { status: "connecting", qr: null, error: null };

  const wClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });
  store.wClient = wClient;

  wClient.on("qr", (qr) => {
    // Store raw QR string — status/route.ts converts it to a data URL
    store.state = { status: "qr_ready", qr, error: null };
  });

  wClient.on("ready", async () => {
    store.state = { status: "connected", qr: null, error: null };
    await refreshGroups();
  });

  wClient.on("auth_failure", (msg) => {
    store.state = { status: "disconnected", qr: null, error: `Auth failure: ${msg}` };
    const stale = store.wClient;
    store.wClient = null;
    stale?.destroy().catch(() => {});
  });

  wClient.on("disconnected", (reason) => {
    store.state = {
      status: "disconnected",
      qr: null,
      error: `Disconnected: ${reason}`,
    };
    const stale = store.wClient;
    store.wClient = null;
    stale?.destroy().catch(() => {});
  });

  wClient.on("message_create", async (msg) => {
    if (!msg.from.endsWith("@g.us")) return;
    await processMessage(msg);
  });

  // initialize() blocks until auth is complete; run it in the background
  // so connect() returns immediately and state updates via events.
  wClient.initialize().catch((err) => {
    // Puppeteer CDP throws ProtocolError when reading the body of a CORS
    // preflight OPTIONS response — benign, ignore it once QR/ready fired.
    if (store.state.status === "connected" || store.state.status === "qr_ready") return;
    store.state = { status: "disconnected", qr: null, error: String(err) };
    const stale = store.wClient;
    store.wClient = null;
    stale?.destroy().catch(() => {});
  });
}

/** Disconnect and destroy the browser. Does not wipe the session. */
export function disconnect(): void {
  try {
    store.wClient?.destroy();
  } catch {
    /* ignore */
  }
  store.wClient = null;
  store.state = { status: "disconnected", qr: null, error: null };
}

/** Destroy the browser, wipe saved credentials, and reset state so the next
 *  connect() call will show a fresh QR code. */
export async function resetSession(): Promise<void> {
  if (store.wClient) {
    try { await store.wClient.destroy(); } catch { /* ignore */ }
    store.wClient = null;
  }
  store.state = { status: "disconnected", qr: null, error: null };
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Re-fetch all groups from WhatsApp and update the DB. */
export async function refreshGroups(): Promise<void> {
  if (!store.wClient || store.state.status !== "connected") return;
  try {
    const chats = await store.wClient.getChats();
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

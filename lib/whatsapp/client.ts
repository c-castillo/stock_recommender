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
import { ensureSerializedId } from "./msg-id";
import {
  pruneBrowserCache,
  pruneWebVersionCache,
  migrateWebVersionCache,
} from "./browser-cache";

// ── Paths ─────────────────────────────────────────────────────────────────────

// Session (Puppeteer user data dir) lives OUTSIDE the project so Turbopack's
// file watcher never encounters Chromium's Unix socket files.
const SESSION_DIR =
  process.env.NODE_ENV === "production"
    ? "/tmp/.stock-recommender-wa"
    : path.join(os.homedir(), ".stock-recommender-wa");

// whatsapp-web.js defaults its web-version cache to ./.wwebjs_cache in the
// process cwd — i.e. inside the project, where it had grown to 131 files /
// 68 MB of index.html snapshots that Turbopack then had to watch. Park it
// next to the session instead, and keep only the newest few (see
// pruneWebVersionCache).
const WEB_CACHE_DIR = path.join(SESSION_DIR, "web-cache");

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
  /** Set synchronously by connect() before it awaits anything. connect() does
   *  async work (cache pruning) before the Client exists, so `wClient` alone
   *  cannot guard re-entry: two overlapping calls both saw it null, both
   *  launched a browser, and the second — losing the race for the profile's
   *  SingletonLock — failed and nulled the FIRST one's reference. That left a
   *  live browser with status "connected" but getClient() === null, which is
   *  how a sync job died instantly with every group stuck at "pending". */
  connecting: Promise<void> | null;
}
const g = globalThis as unknown as { __waClient?: WaGlobal };
g.__waClient ??= {
  state: { status: "disconnected", qr: null, error: null },
  wClient: null,
  connecting: null,
};
g.__waClient.connecting ??= null; // older pinned objects predate this field
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
  if (store.connecting) return store.connecting; // already starting up

  store.state = { status: "connecting", qr: null, error: null };
  store.connecting = startClient().finally(() => {
    store.connecting = null;
  });
  return store.connecting;
}

async function startClient(): Promise<void> {
  // Startup housekeeping. Safe only while no browser is attached to the
  // profile, which connect()'s wClient + connecting guards together ensure.
  // Chromium's disposable caches had reached ~2 GB, and it opens and validates
  // all of it before the page starts loading.
  fs.mkdirSync(WEB_CACHE_DIR, { recursive: true });
  migrateWebVersionCache(path.join(process.cwd(), ".wwebjs_cache"), WEB_CACHE_DIR);
  await pruneBrowserCache(SESSION_DIR);
  pruneWebVersionCache(WEB_CACHE_DIR);

  const wClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    webVersionCache: { type: "local", path: WEB_CACHE_DIR },
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        // Bound the HTTP cache, which was the single largest slice of the
        // profile (1.0 GB). This does not cover the service worker's
        // CacheStorage — that is quota-managed and will regrow, which is why
        // pruneBrowserCache() above still has to run.
        "--disk-cache-size=104857600", // 100 MB
        // Chromium throttles timers in renderers it considers backgrounded or
        // occluded. Our page is never focused, so without these WhatsApp Web's
        // history-sync and store-hydration loops run at ~1 Hz.
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        // Startup work we have no use for in a headless scraper.
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-component-update",
        "--disable-background-networking",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
      ],
    },
  });
  store.wClient = wClient;

  // Every handler below must confirm it is still the ACTIVE client before
  // touching shared state. A client that lost the race for the profile lock,
  // or one orphaned by a hot reload, would otherwise overwrite the live
  // connection's status or null out its reference.
  const isCurrent = () => store.wClient === wClient;
  const teardown = (state: State) => {
    if (!isCurrent()) {
      wClient.destroy().catch(() => {});
      return;
    }
    store.state = state;
    store.wClient = null;
    wClient.destroy().catch(() => {});
  };

  wClient.on("qr", (qr) => {
    if (!isCurrent()) return;
    // Store raw QR string — status/route.ts converts it to a data URL
    store.state = { status: "qr_ready", qr, error: null };
  });

  wClient.on("ready", async () => {
    if (!isCurrent()) return;
    store.state = { status: "connected", qr: null, error: null };
    await refreshGroups();
  });

  wClient.on("auth_failure", (msg) => {
    teardown({ status: "disconnected", qr: null, error: `Auth failure: ${msg}` });
  });

  wClient.on("disconnected", (reason) => {
    teardown({ status: "disconnected", qr: null, error: `Disconnected: ${reason}` });
  });

  wClient.on("message_create", async (msg) => {
    if (!isCurrent()) return;
    if (!msg.from.endsWith("@g.us")) return;
    await processMessage(msg);
  });

  // initialize() blocks until auth is complete; run it in the background
  // so connect() returns immediately and state updates via events.
  // Deliberately NOT awaited: initialize() blocks until auth completes, which
  // on a fresh QR login means until the user scans it. connect() must return
  // as soon as the client exists so the POST doesn't hang for minutes — state
  // reaches the UI through the events above. By this point store.wClient is
  // set, so the `if (store.wClient) return` guard in connect() covers re-entry
  // from here on and `connecting` has done its job.
  wClient.initialize().catch((err) => {
    // Puppeteer CDP throws ProtocolError when reading the body of a CORS
    // preflight OPTIONS response — benign, ignore it once QR/ready fired.
    if (store.state.status === "connected" || store.state.status === "qr_ready") return;
    console.error("[whatsapp] initialize failed:", err);
    teardown({ status: "disconnected", qr: null, error: String(err) });
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

// Coalesce concurrent refreshes (the status poll can fire while `ready`'s own
// refresh is still awaiting) and throttle empty-result retries.
let refreshInFlight: Promise<void> | null = null;
let lastRefreshAttempt = 0;

// Raw (unserialized) shape of a WhatsApp Web Chat model — only the slice we
// read below. Any WhatsApp release can rename these, so the evaluate() stays
// defensive and every field is optional. See sync-jobs.ts for the same pattern.
interface WaRawChat {
  id?: { _serialized?: string };
  name?: string;
  formattedTitle?: string;
}
interface WaChatWindow {
  require(mod: "WAWebCollections"): { Chat?: { getModelsArray?(): WaRawChat[] } };
}

/** Re-fetch all groups from WhatsApp and update the DB. */
export async function refreshGroups(): Promise<void> {
  if (!store.wClient || store.state.status !== "connected") return;
  if (refreshInFlight) return refreshInFlight;
  const client = store.wClient;
  refreshInFlight = (async () => {
    try {
      const page = client.pupPage;
      if (!page) return;
      // whatsapp-web.js's client.getChats() maps getChatModel() over EVERY chat
      // inside a single Promise.all: it fetches group metadata, migrates LID
      // participants, and hydrates last messages. If any one chat (a newsletter,
      // a broken participant, an announce channel) throws, the whole call
      // rejects with an opaque minified error ("r: r"). We only need each
      // group's jid + name, so read those straight off the Chat collection and
      // wrap each chat so one bad entry can't sink the entire list.
      const groups: { jid: string; name: string }[] = await page.evaluate(() => {
        const w = window as unknown as WaChatWindow;
        const chats = w.require("WAWebCollections").Chat?.getModelsArray?.() ?? [];
        const out: { jid: string; name: string }[] = [];
        for (const c of chats) {
          try {
            const jid = c?.id?._serialized;
            if (!jid || !jid.endsWith("@g.us")) continue;
            out.push({ jid, name: c?.name ?? c?.formattedTitle ?? jid });
          } catch {
            /* skip a chat that won't read — don't fail the whole refresh */
          }
        }
        return out;
      });
      // WhatsApp fires `ready` before the chat store is fully hydrated, so an
      // early read can come back empty. Don't overwrite with nothing —
      // ensureGroups() will retry on the next status poll until chats load.
      if (groups.length > 0) upsertGroups(groups);
    } catch (err) {
      // Previously swallowed silently, which is how the group list could stay
      // empty forever with no trace. Surface it in the server logs.
      console.error("[whatsapp] refreshGroups failed:", err);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Refresh groups only if none are cached yet. Cheap to call on every status
 *  poll: it self-heals a connected session whose initial `ready` refresh came
 *  back empty (chats not synced yet), and no-ops once groups exist. */
export async function ensureGroups(): Promise<void> {
  if (store.state.status !== "connected") return;
  if (listGroups().length > 0) return;
  if (Date.now() - lastRefreshAttempt < 4000) return;
  lastRefreshAttempt = Date.now();
  await refreshGroups();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function processMessage(msg: Message) {
  const jid = msg.from;
  const id = ensureSerializedId(msg) ?? msg.id._serialized;
  const ts = msg.timestamp;
  const sender = msg.author ?? msg.from;
  const body = msg.body || null;

  let mediaResult = null;
  if (msg.hasMedia) {
    try {
      mediaResult = await downloadAndSave(msg);
    } catch (err) {
      console.error(`[whatsapp] media download failed for ${id}:`, err);
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

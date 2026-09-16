/**
 * Sync job manager.
 *
 * Uses two complementary mechanisms to load full message history:
 *
 * 1. sendPeerDataOperationRequest(3) — the WhatsApp protocol-level
 *    HISTORY_SYNC_ON_DEMAND request (same as Baileys' fetchMessageHistory).
 *    Reaches the server and asks it to push older messages.
 *
 * 2. loadEarlierMsgs with isFullyLoaded reset — forces the in-browser
 *    pager to request more messages even after it has marked the chat
 *    as "fully loaded" following the initial 15-message sync.
 *
 * After triggering both, we poll chat.msgs.length until it stops growing,
 * re-firing the requests on each page so the server keeps feeding chunks.
 */

import { randomUUID } from "crypto";
import { getClient, getStatus } from "./client";
import {
  countAllMessages,
  countAllMedia,
  upsertGroup,
  insertMessage,
  getNewestMessage,
  getStoredMediaState,
} from "./db";
import { downloadAndSave } from "./media";
import { ensureSerializedId } from "./msg-id";
import { ensureMediaDigests } from "@/lib/ai/media-digest";
import * as WWebJS from "whatsapp-web.js";
import type { Client, Message } from "whatsapp-web.js";

// Message is a runtime class but whatsapp-web.js's bundled .d.ts only types it
// as an interface, so reach the constructor through the module with a cast.
const MessageCtor = (WWebJS as unknown as {
  Message: new (client: Client, data: unknown) => Message;
}).Message;

// ── WhatsApp Web internals (browser context) ──────────────────────────────────
//
// The evaluate() blocks below reach into WhatsApp Web's minified, undocumented
// `window.Store`. These declarations cover only the slice we touch. They are a
// description of observed runtime shape, not a contract — any WhatsApp release
// can rename or drop these, which is why every call site stays defensive and
// the optional members are marked optional rather than assumed present.

interface WaMsgModel {
  t?: number;
  messageTimestamp?: number;
  isNotification?: boolean;
}

interface WaMsgLoadState {
  isFullyLoaded?: boolean;
  set?: (patch: { isFullyLoaded: boolean }) => void;
}

interface WaMsgCollection {
  msgLoadState?: WaMsgLoadState;
  getModelsArray(): WaMsgModel[];
}

interface WaChat {
  id: unknown;
  endOfHistoryTransferType?: number;
  msgs: WaMsgCollection;
}

interface WaWindow {
  Store: {
    WidFactory: { createWid(id: string): unknown };
    Chat: { get(wid: unknown): WaChat | null | undefined };
    HistorySync: {
      sendPeerDataOperationRequest(type: number, opts: { chatId: unknown }): Promise<void>;
    };
    ConversationMsgs: {
      loadEarlierMsgs(chat: WaChat, msgs: WaMsgCollection): Promise<void>;
      loadAfterMsgsBatch?: (chat: WaChat, msgs: WaMsgCollection) => Promise<void>;
      loadAfterMsgs?: (chat: WaChat, msgs: WaMsgCollection) => Promise<void>;
    };
    Cmd: { openChatBottom(opts: { chat: WaChat }): Promise<void> };
  };
  WWebJS: {
    getChat(chatId: string, opts: { getAsModel: boolean }): Promise<WaChat | null>;
    getMessageModel(msg: WaMsgModel): unknown;
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type GroupSyncStatus =
  | "pending"
  | "fetching"
  | "processing"
  | "done"
  | "error";

export interface GroupProgress {
  jid: string;
  name: string;
  status: GroupSyncStatus;
  messagesReceived: number;
  mediaDownloaded: number;
  page: number;
  error?: string;
}

export type JobStatus = "running" | "done" | "error";

export interface SyncJob {
  id: string;
  status: JobStatus;
  startedAt: number;
  completedAt?: number;
  groups: GroupProgress[];
  /** Backfill mode: widen the window and re-scan past history to fill gaps. */
  backfill: boolean;
  /** Why the job as a whole failed, when it died before/outside any single
   *  group. Without this a job-level throw left every group sitting at
   *  "pending" with no explanation anywhere — the UI showed "En cola" forever
   *  and the error was discarded by the catch below. */
  error?: string;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let activeJob: SyncJob | null = null;

export function getActiveSyncJob(): SyncJob | null {
  return activeJob;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface GroupInput {
  jid: string;
  name: string;
}

export interface SyncOptions {
  /** When true, re-scan the full window (14 days) to backfill missing messages
   *  instead of only fetching messages newer than what's already stored. */
  backfill?: boolean;
}

export async function startSyncJob(
  groups: GroupInput[],
  opts: SyncOptions = {}
): Promise<SyncJob> {
  if (activeJob?.status === "running") {
    throw new Error("Ya hay una sincronización en curso");
  }
  if (getStatus().status !== "connected") {
    throw new Error("WhatsApp no está conectado");
  }

  const job: SyncJob = {
    id: randomUUID(),
    status: "running",
    startedAt: Date.now(),
    backfill: opts.backfill ?? false,
    groups: groups.map((g) => ({
      jid: g.jid,
      name: g.name,
      status: "pending",
      messagesReceived: 0,
      mediaDownloaded: 0,
      page: 0,
    })),
  };

  activeJob = job;

  runJob(job).catch((err) => {
    job.status = "error";
    job.error = errText(err);
    job.completedAt = Date.now();
    console.error("[whatsapp] sync job failed:", err);
  });

  return job;
}

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_MESSAGES = 10_000;
/** Upper bound on how long we wait for a triggered load to deliver messages.
 *  Reached only when nothing arrives — see waitForGrowth(). */
const POLL_INTERVAL_MS = 2_500;
/** How often we re-check the browser store while waiting inside that bound.
 *  Chunks usually land in a few hundred ms, so a fixed sleep of POLL_INTERVAL_MS
 *  per page spent most of the sync idle: 100+ pages across all groups meant
 *  minutes of pure waiting. Poll instead and continue the moment data lands. */
const GROWTH_CHECK_MS = 250;
/** Floor on a page's wall time. The waits above exist to give the server time
 *  to deliver, but they also pace our requests: without a floor a fast-growing
 *  chat would fire sendPeerDataOperationRequest every ~250 ms and risk being
 *  throttled. 500 ms still cuts the old fixed 2.5 s per page by 5x. */
const MIN_ROUND_MS = 500;
/** How many media files to download concurrently. Each downloadMedia() is a
 *  network fetch plus a base64 round trip over CDP; serial was the dominant
 *  cost of Phase 2 for media-heavy groups. */
const MEDIA_CONCURRENCY = 4;
/** consecutive polls with no growth before we consider history exhausted.
 *  Backfill uses a higher bound: the server often dribbles out the middle of a
 *  history gap over several requests, so we give it more no-growth retries
 *  before concluding the chunk won't arrive. */
const MAX_STABLE_ROUNDS = 4;
const MAX_STABLE_ROUNDS_BACKFILL = 10;
/** max forward-load rounds when pulling the most-recent window into the store */
const MAX_LATEST_ROUNDS = 6;
/** hard page limit per group */
const MAX_PAGES = 100;
/** only sync messages from the last N days (normal incremental sync) */
const SYNC_DAYS = 7;
/** wider window used for backfill runs */
const BACKFILL_DAYS = 14;

// ── Internal runner ───────────────────────────────────────────────────────────

async function runJob(job: SyncJob) {
  const client = getClient();
  if (!client) {
    job.status = "error";
    job.error =
      "No hay cliente de WhatsApp activo (getClient() devolvió null). " +
      "Reconecta antes de sincronizar.";
    job.completedAt = Date.now();
    console.error("[whatsapp]", job.error);
    return;
  }

  // Backfill widens the window and disables the forward-only cursor so the
  // run re-scans past history and fills gaps; INSERT OR IGNORE dedupes.
  const windowDays = job.backfill ? BACKFILL_DAYS : SYNC_DAYS;

  for (const gp of job.groups) {
    try {
      // Inside the try: a throw here used to escape the per-group handler and
      // abort the entire job, leaving every remaining group at "pending".
      upsertGroup(gp.jid, gp.name);
      gp.status = "fetching";

      // Hard cutoff: only sync the last `windowDays` days (unix seconds).
      const cutoffTs = Math.floor(Date.now() / 1000) - windowDays * 86400;

      // Cursor: timestamp of the newest message already stored for this group.
      // Used to stop the pagination loop once the browser has loaded messages
      // older than what we already have, and to skip processing known messages.
      // Suppressed in backfill mode so the full window is re-scanned for gaps.
      const newestStored = getNewestMessage(gp.jid);
      const newestStoredTs = job.backfill ? null : (newestStored?.ts ?? null);

      await ensureStoreShim(client);

      // ── Phase 0: force-load the most recent messages ────────────────────
      // fetchMessages / loadEarlierMsgs only ever page *backward*. If the
      // browser's recent window is stale — e.g. the live socket missed
      // messages while the process was busy or briefly disconnected — the
      // backward loop below can never recover them, silently truncating the
      // sync to whatever happened to be in the store. Pull the chat to the
      // bottom first (the one path that fetches messages *newer* than what is
      // loaded) until the store's newest message stops advancing, so today's
      // messages are guaranteed present before we paginate into history.
      await loadLatestWindow(client, gp.jid);

      // ── Phase 1: load history into the browser store ────────────────────
      let loadedCount = (await getChatStats(client, gp.jid)).count;
      let stableRounds = 0;
      const maxStableRounds = job.backfill ? MAX_STABLE_ROUNDS_BACKFILL : MAX_STABLE_ROUNDS;

      while (loadedCount < MAX_MESSAGES && stableRounds < maxStableRounds && gp.page < MAX_PAGES) {
        // Fire both mechanisms each iteration so we keep feeding the server
        // with requests as it delivers chunks.
        await triggerHistoryLoad(client, gp.jid);

        // Return as soon as the chunk lands rather than always burning the
        // full POLL_INTERVAL_MS. One combined read gets the count and the
        // oldest timestamp the loop needs, halving the CDP round trips.
        const stats = await waitForGrowth(client, gp.jid, loadedCount);
        const newCount = stats.count;
        gp.page += 1;
        gp.messagesReceived = newCount;

        if (newCount > loadedCount) {
          loadedCount = newCount;
          stableRounds = 0;
        } else {
          stableRounds += 1;
        }

        const oldestBrowserTs = stats.oldestTs;

        // Early stop: browser has gone back past the cutoff. Suppressed in
        // backfill mode: the store usually already spans further back than the
        // window (from prior syncs), so this would break on the first
        // iteration and never let the protocol history-sync re-fire enough
        // times to fill an interior gap. In backfill we instead rely on
        // maxStableRounds to bound the loop.
        if (!job.backfill && oldestBrowserTs !== null && oldestBrowserTs < cutoffTs) break;

        // Early stop: if the browser store now contains messages older than
        // our newest stored record, we've fully covered the gap — no need to
        // paginate further back.
        if (newestStoredTs !== null && oldestBrowserTs !== null && oldestBrowserTs <= newestStoredTs) break;
      }

      // ── Phase 2: retrieve all messages now in the store ────────────────
      gp.status = "processing";
      // NB: deliberately NOT client.getChatById() here. For groups that path
      // builds the full Chat model — groupMetadata.update() (a network fetch),
      // @lid participant remapping, groupMetadata.serialize() — none of which
      // we use, and any of which throws a minified "r: r" for groups whose
      // metadata can't be resolved (left/announcement/community groups),
      // failing the whole sync. fetchGroupMessages reads messages via the
      // lightweight getChat({ getAsModel: false }) path instead.
      let messages: Message[];
      try {
        // The cutoff is applied inside the browser: the store can hold 10k
        // messages going back years, and serializing all of them across CDP
        // just to drop most of them in Node was the bulk of Phase 2's cost.
        messages = await fetchGroupMessages(
          client,
          gp.jid,
          Math.max(loadedCount, 1),
          cutoffTs
        );
      } catch (err) {
        throw new Error(`fetchGroupMessages failed: ${errText(err)}`);
      }

      // Everything we already hold in this window, and whether its media file
      // landed. Lets us skip a message before paying for its media — including
      // messages newer than newestStoredTs, which the live listener has usually
      // already stored and which the timestamp cursor alone re-downloaded on
      // every run.
      const stored = getStoredMediaState(gp.jid, cutoffTs);

      // Collect first, then download media in parallel. Serial downloads made
      // Phase 2 scale with (media count x round-trip latency).
      const pending: { msg: Message; id: string; body: string | null }[] = [];
      for (const msg of messages) {
        if (msg.timestamp < cutoffTs) continue;
        if (newestStoredTs !== null && msg.timestamp < newestStoredTs) continue;

        const body = msg.body || null;
        if (!body && !msg.hasMedia) continue;

        const serializedId = ensureSerializedId(msg) ?? msg.id._serialized;
        if (!serializedId) continue;

        // Already stored — skip, unless it is a media message whose file never
        // made it to disk. Re-running those is the recovery path: the upsert in
        // insertMessage() COALESCEs the media columns back in.
        if (stored.has(serializedId) && (!msg.hasMedia || stored.get(serializedId)))
          continue;

        pending.push({ msg, id: serializedId, body });
      }

      const media = new Map<string, Awaited<ReturnType<typeof downloadAndSave>>>();
      const withMedia = pending.filter((p) => p.msg.hasMedia);
      let cursor = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(MEDIA_CONCURRENCY, withMedia.length) },
          async () => {
            while (cursor < withMedia.length) {
              const { msg, id } = withMedia[cursor++];
              try {
                media.set(id, await downloadAndSave(msg));
              } catch (err) {
                console.error(`[whatsapp] media download failed for ${id}:`, err);
              }
            }
          }
        )
      );

      for (const { msg, id, body } of pending) {
        const mediaResult = media.get(id) ?? null;
        const effectiveBody =
          body ?? (mediaResult ? `[${mediaResult.media_type}]` : `[${msg.type}]`);

        try {
          insertMessage({
            id,
            jid: gp.jid,
            sender: msg.author ?? msg.from,
            body: effectiveBody,
            ts: msg.timestamp,
            media_type: mediaResult?.media_type ?? null,
            media_mime: mediaResult?.media_mime ?? null,
            media_filename: mediaResult?.media_filename ?? null,
            media_path: mediaResult?.media_path ?? null,
          });
        } catch {
          /* duplicate — ignore */
        }
      }

      gp.messagesReceived = countAllMessages(gp.jid);
      gp.mediaDownloaded = countAllMedia(gp.jid);
      gp.status = "done";
    } catch (err) {
      gp.status = "error";
      gp.error = errText(err);
    }
  }

  // Stage 1 at ingestion: digest freshly downloaded charts/PDFs so the analysis
  // call never has to. Best-effort and capped — never fails the sync job.
  try {
    await ensureMediaDigests(windowDays);
  } catch {
    /* digests retried on next sync or at analysis time */
  }

  job.status = "done";
  job.completedAt = Date.now();
}

// ── Browser helpers ───────────────────────────────────────────────────────────

/**
 * Rebuild the legacy `window.Store` facade from WhatsApp Web's module registry.
 *
 * whatsapp-web.js 1.34 stopped injecting `window.Store` and reaches modules via
 * `window.require` instead. Every helper below swallows errors, so without this
 * getChatStats() reported an empty store, fetchGroupMessages() was called with
 * limit 1, and each sync persisted only the single newest message per group.
 * Throws (failing the group loudly) if the modules can't be resolved.
 */
async function ensureStoreShim(client: Client): Promise<void> {
  const page = client.pupPage;
  if (!page) return;

  const ok = await page.evaluate(() => {
    const w = window as unknown as Partial<WaWindow> & {
      require?: (name: string) => Record<string, unknown>;
    };
    if (w.Store?.Chat) return true;
    const req = w.require;
    if (typeof req !== "function") return false;
    try {
      const load = req("WAWebChatLoadMessages") as {
        loadEarlierMsgs(opts: { chat: WaChat }): Promise<void>;
      };
      w.Store = {
        WidFactory: req("WAWebWidFactory") as WaWindow["Store"]["WidFactory"],
        Chat: req("WAWebCollections").Chat as WaWindow["Store"]["Chat"],
        HistorySync: req("WAWebSendNonMessageDataRequest") as WaWindow["Store"]["HistorySync"],
        ConversationMsgs: {
          loadEarlierMsgs: (chat) => load.loadEarlierMsgs({ chat }),
        },
        Cmd: req("WAWebCmd").Cmd as WaWindow["Store"]["Cmd"],
      };
      return Boolean(w.Store.Chat && w.Store.WidFactory);
    } catch {
      return false;
    }
  });

  if (!ok) {
    throw new Error(
      "WhatsApp Web internals unavailable (window.Store / window.require): " +
        "sync would silently store only the newest message"
    );
  }
}

/**
 * Fire both history-loading mechanisms inside the browser:
 *
 * A) sendPeerDataOperationRequest(3) — protocol-level HISTORY_SYNC_ON_DEMAND.
 *    Works even for announcement/read-only groups. Gated on
 *    endOfHistoryTransferType === 0; we force-reset that flag so it always
 *    fires.
 *
 * B) loadEarlierMsgs with isFullyLoaded reset — in-browser pager. Bypasses
 *    the "fully loaded" short-circuit so it actually contacts the server.
 */
async function triggerHistoryLoad(client: Client, jid: string): Promise<void> {
  const page = client.pupPage;
  if (!page) return;

  await page.evaluate(async (chatId: string) => {
    const w = window as unknown as WaWindow;
    try {
      const chatWid = w.Store.WidFactory.createWid(chatId);
      const chat = w.Store.Chat.get(chatWid);
      if (!chat) return;

      // (A) Protocol-level history sync — mirrors Baileys' fetchMessageHistory.
      // Reset endOfHistoryTransferType so the guard doesn't block the call.
      const prevTransferType = chat.endOfHistoryTransferType;
      chat.endOfHistoryTransferType = 0;
      try {
        await w.Store.HistorySync.sendPeerDataOperationRequest(3, { chatId: chat.id });
      } catch { /* ignore */ }
      chat.endOfHistoryTransferType = prevTransferType;

      // (B) In-browser pager — reset "fully loaded" so it sends a server request.
      const ls = chat.msgs?.msgLoadState;
      if (ls) {
        if (typeof ls.set === "function") ls.set({ isFullyLoaded: false });
        else ls.isFullyLoaded = false;
      }
      try {
        await w.Store.ConversationMsgs.loadEarlierMsgs(chat, chat.msgs);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }, jid);
}

/**
 * Force the browser store to load the most-recent messages for a chat.
 *
 * openChatBottom scrolls the chat to the bottom, which is the one code path
 * that makes WhatsApp fetch messages *newer* than what is already loaded —
 * loadEarlierMsgs only ever pages backward. We also reset the "fully loaded"
 * flag and try the forward pager if this build exposes it.
 */
async function triggerLatestLoad(client: Client, jid: string): Promise<void> {
  const page = client.pupPage;
  if (!page) return;

  await page.evaluate(async (chatId: string) => {
    const w = window as unknown as WaWindow;
    try {
      const chatWid = w.Store.WidFactory.createWid(chatId);
      const chat = w.Store.Chat.get(chatWid);
      if (!chat) return;

      // Reset "fully loaded" so the pager will contact the server again.
      const ls = chat.msgs?.msgLoadState;
      if (ls) {
        if (typeof ls.set === "function") ls.set({ isFullyLoaded: false });
        else ls.isFullyLoaded = false;
      }

      // (A) Scroll-to-bottom — fetches the most recent messages from server.
      try { await w.Store.Cmd.openChatBottom({ chat }); } catch { /* ignore */ }

      // (B) Forward pager, if this WhatsApp build exposes it.
      try {
        const cm = w.Store.ConversationMsgs;
        const loadAfter = cm?.loadAfterMsgsBatch ?? cm?.loadAfterMsgs;
        if (loadAfter) await loadAfter(chat, chat.msgs);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }, jid);
}

/**
 * Fetch all messages currently loaded in the browser store for a chat, without
 * building the full Chat model. Mirrors whatsapp-web.js's Chat.fetchMessages,
 * but uses getChat({ getAsModel: false }) so it never touches group metadata
 * (the part that throws a minified "r: r" for groups we can't resolve). We
 * already paginated history into the store in Phase 1, so no loadEarlierMsgs
 * loop is needed — we just serialize and rebuild Message instances.
 */
async function fetchGroupMessages(
  client: Client,
  jid: string,
  limit: number,
  cutoffTs: number
): Promise<Message[]> {
  const page = client.pupPage;
  if (!page) return [];

  const models: unknown[] = await page.evaluate(
    async (chatId: string, lim: number, cutoff: number) => {
      const w = window as unknown as WaWindow;
      const chat = await w.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat) return [];
      let msgs = chat.msgs.getModelsArray().filter((m) => {
        if (m.isNotification) return false;
        // Drop pre-cutoff messages here, before serialization. getMessageModel()
        // produces a large object per message and the whole array crosses CDP
        // as JSON, so filtering in Node instead would mean paying for years of
        // history to keep one week of it.
        const t = m.t ?? m.messageTimestamp;
        return t === undefined || t >= cutoff;
      });
      if (lim > 0 && msgs.length > lim) {
        msgs.sort((a, b) => ((a.t ?? 0) > (b.t ?? 0) ? 1 : -1));
        msgs = msgs.slice(msgs.length - lim);
      }
      return msgs.map((m) => w.WWebJS.getMessageModel(m));
    },
    jid,
    limit,
    cutoffTs
  );

  return models.map((m) => new MessageCtor(client, m));
}

/**
 * Read everything the pagination loops need about a chat in ONE page.evaluate:
 * how many messages the browser store holds, and the oldest/newest timestamps
 * among them. Previously these were three separate evaluates fired several
 * times per page — each a full CDP round trip for a single number.
 */
interface ChatStats {
  count: number;
  oldestTs: number | null;
  newestTs: number | null;
}

async function getChatStats(client: Client, jid: string): Promise<ChatStats> {
  const page = client.pupPage;
  if (!page) return { count: 0, oldestTs: null, newestTs: null };

  return page.evaluate((chatId: string): ChatStats => {
    const w = window as unknown as WaWindow;
    try {
      const chatWid = w.Store.WidFactory.createWid(chatId);
      const chat = w.Store.Chat.get(chatWid);
      const msgs = chat?.msgs?.getModelsArray() ?? [];
      let oldest: number | null = null;
      let newest: number | null = null;
      for (const m of msgs) {
        const t = m.t ?? m.messageTimestamp ?? null;
        if (t === null) continue;
        if (oldest === null || t < oldest) oldest = t;
        if (newest === null || t > newest) newest = t;
      }
      return { count: msgs.length, oldestTs: oldest, newestTs: newest };
    } catch {
      return { count: 0, oldestTs: null, newestTs: null };
    }
  }, jid);
}

/**
 * Wait for the browser store to grow past `baseline`, up to POLL_INTERVAL_MS.
 *
 * Returns as soon as new messages land — typically a few hundred ms after the
 * trigger — instead of always sleeping the full interval. Only a round that
 * genuinely delivers nothing pays the whole bound, which is exactly the case
 * where the wait is load-bearing (it is how we conclude history is exhausted).
 */
async function waitForGrowth(
  client: Client,
  jid: string,
  baseline: number
): Promise<ChatStats> {
  const start = Date.now();
  const deadline = start + POLL_INTERVAL_MS;
  let stats = await getChatStats(client, jid);
  while (stats.count <= baseline && Date.now() < deadline) {
    await sleep(GROWTH_CHECK_MS);
    stats = await getChatStats(client, jid);
  }

  const remaining = MIN_ROUND_MS - (Date.now() - start);
  if (remaining > 0) {
    await sleep(remaining);
    stats = await getChatStats(client, jid); // re-read: more may have landed
  }
  return stats;
}

/**
 * Repeatedly pull the most-recent window until the store's newest message
 * stops advancing — i.e. the recent window is fully materialised. Bounded by
 * MAX_LATEST_ROUNDS so a hot, constantly-updating chat can't loop forever.
 */
async function loadLatestWindow(client: Client, jid: string): Promise<void> {
  let prevNewest = (await getChatStats(client, jid)).newestTs ?? -Infinity;
  let stableRounds = 0;
  for (let i = 0; i < MAX_LATEST_ROUNDS && stableRounds < 2; i++) {
    await triggerLatestLoad(client, jid);

    // Poll for a newer message rather than always sleeping the full interval.
    // With 100+ groups this phase alone used to cost a guaranteed 5 s each.
    const start = Date.now();
    const deadline = start + POLL_INTERVAL_MS;
    let newest = prevNewest;
    do {
      await sleep(GROWTH_CHECK_MS);
      newest = (await getChatStats(client, jid)).newestTs ?? -Infinity;
    } while (newest <= prevNewest && Date.now() < deadline);

    const remaining = MIN_ROUND_MS - (Date.now() - start);
    if (remaining > 0) await sleep(remaining);

    if (newest > prevNewest) {
      prevNewest = newest;
      stableRounds = 0;
    } else {
      stableRounds += 1;
    }
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Render an error for display/logging. whatsapp-web.js surfaces failures from
 * inside the minified WhatsApp Store as Errors whose name+message are both
 * mangled (e.g. "r: r"), which is useless on its own. Prefer the stack — its
 * frame names still identify the failing function — falling back to message.
 */
function errText(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message || String(err);
  return String(err);
}

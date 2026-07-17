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
import { countAllMessages, countAllMedia, upsertGroup, insertMessage, getNewestMessage } from "./db";
import { downloadAndSave } from "./media";
import { ensureMediaDigests } from "@/lib/ai/media-digest";
import * as WWebJS from "whatsapp-web.js";
import type { Client, Message } from "whatsapp-web.js";

// Message is a runtime class but whatsapp-web.js's bundled .d.ts only types it
// as an interface, so reach the constructor through the module with a cast.
const MessageCtor = (WWebJS as unknown as {
  Message: new (client: Client, data: unknown) => Message;
}).Message;

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

  runJob(job).catch(() => {
    job.status = "error";
    job.completedAt = Date.now();
  });

  return job;
}

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_MESSAGES = 10_000;
/** ms to wait after triggering a load before measuring growth */
const POLL_INTERVAL_MS = 2_500;
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
    job.completedAt = Date.now();
    return;
  }

  // Backfill widens the window and disables the forward-only cursor so the
  // run re-scans past history and fills gaps; INSERT OR IGNORE dedupes.
  const windowDays = job.backfill ? BACKFILL_DAYS : SYNC_DAYS;

  for (const gp of job.groups) {
    upsertGroup(gp.jid, gp.name);

    try {
      gp.status = "fetching";

      // Hard cutoff: only sync the last `windowDays` days (unix seconds).
      const cutoffTs = Math.floor(Date.now() / 1000) - windowDays * 86400;

      // Cursor: timestamp of the newest message already stored for this group.
      // Used to stop the pagination loop once the browser has loaded messages
      // older than what we already have, and to skip processing known messages.
      // Suppressed in backfill mode so the full window is re-scanned for gaps.
      const newestStored = getNewestMessage(gp.jid);
      const newestStoredTs = job.backfill ? null : (newestStored?.ts ?? null);

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
      let loadedCount = await getChatMsgCount(client, gp.jid);
      let stableRounds = 0;
      const maxStableRounds = job.backfill ? MAX_STABLE_ROUNDS_BACKFILL : MAX_STABLE_ROUNDS;

      while (loadedCount < MAX_MESSAGES && stableRounds < maxStableRounds && gp.page < MAX_PAGES) {
        // Fire both mechanisms each iteration so we keep feeding the server
        // with requests as it delivers chunks.
        await triggerHistoryLoad(client, gp.jid);
        await sleep(POLL_INTERVAL_MS);

        const newCount = await getChatMsgCount(client, gp.jid);
        gp.page += 1;
        gp.messagesReceived = newCount;

        if (newCount > loadedCount) {
          loadedCount = newCount;
          stableRounds = 0;
        } else {
          stableRounds += 1;
        }

        const oldestBrowserTs = await getOldestBrowserMsgTs(client, gp.jid);

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
        messages = await fetchGroupMessages(client, gp.jid, Math.max(loadedCount, 1));
      } catch (err) {
        throw new Error(`fetchGroupMessages failed: ${errText(err)}`);
      }

      for (const msg of messages) {
        // Skip messages outside the 7-day window.
        if (msg.timestamp < cutoffTs) continue;

        // Skip messages we already have — avoids redundant media downloads
        // and insert attempts. INSERT OR IGNORE would handle duplicates, but
        // this is cheaper for large already-synced groups.
        if (newestStoredTs !== null && msg.timestamp < newestStoredTs) continue;

        const body = msg.body || null;
        if (!body && !msg.hasMedia) continue;

        let mediaResult = null;
        if (msg.hasMedia) {
          try {
            mediaResult = await downloadAndSave(msg);
          } catch {
            /* ignore — save without media */
          }
        }

        const effectiveBody =
          body ?? (mediaResult ? `[${mediaResult.media_type}]` : `[${msg.type}]`);

        try {
          insertMessage({
            id: msg.id._serialized,
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

  await (page as any).evaluate(async (chatId: string) => {
    const w = window as any;
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
      } catch (_) { /* ignore */ }
      chat.endOfHistoryTransferType = prevTransferType;

      // (B) In-browser pager — reset "fully loaded" so it sends a server request.
      const ls = chat.msgs?.msgLoadState;
      if (ls) {
        if (typeof ls.set === "function") ls.set({ isFullyLoaded: false });
        else ls.isFullyLoaded = false;
      }
      try {
        await w.Store.ConversationMsgs.loadEarlierMsgs(chat, chat.msgs);
      } catch (_) { /* ignore */ }
    } catch (_) { /* ignore */ }
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

  await (page as any).evaluate(async (chatId: string) => {
    const w = window as any;
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
      try { await w.Store.Cmd.openChatBottom({ chat }); } catch (_) { /* ignore */ }

      // (B) Forward pager, if this WhatsApp build exposes it.
      try {
        const cm = w.Store.ConversationMsgs;
        const loadAfter = cm?.loadAfterMsgsBatch ?? cm?.loadAfterMsgs;
        if (loadAfter) await loadAfter(chat, chat.msgs);
      } catch (_) { /* ignore */ }
    } catch (_) { /* ignore */ }
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
async function fetchGroupMessages(client: Client, jid: string, limit: number): Promise<Message[]> {
  const page = client.pupPage;
  if (!page) return [];

  const models: any[] = await (page as any).evaluate(
    async (chatId: string, lim: number) => {
      const w = window as any;
      const chat = await w.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat) return [];
      let msgs: any[] = chat.msgs.getModelsArray().filter((m: any) => !m.isNotification);
      if (lim > 0 && msgs.length > lim) {
        msgs.sort((a: any, b: any) => (a.t > b.t ? 1 : -1));
        msgs = msgs.slice(msgs.length - lim);
      }
      return msgs.map((m: any) => w.WWebJS.getMessageModel(m));
    },
    jid,
    limit
  );

  return models.map((m) => new MessageCtor(client, m));
}

/** Return the timestamp of the newest message currently in the browser's store. */
async function getNewestBrowserMsgTs(client: Client, jid: string): Promise<number | null> {
  const page = client.pupPage;
  if (!page) return null;

  return (page as any).evaluate((chatId: string) => {
    const w = window as any;
    try {
      const chatWid = w.Store.WidFactory.createWid(chatId);
      const chat = w.Store.Chat.get(chatWid);
      const msgs: any[] = chat?.msgs?.getModelsArray() ?? [];
      if (!msgs.length) return null;
      return msgs.reduce((max, m) => {
        const t = m.t ?? m.messageTimestamp ?? null;
        return t !== null && t > max ? t : max;
      }, -Infinity) as number;
    } catch (_) {
      return null;
    }
  }, jid);
}

/**
 * Repeatedly pull the most-recent window until the store's newest message
 * stops advancing — i.e. the recent window is fully materialised. Bounded by
 * MAX_LATEST_ROUNDS so a hot, constantly-updating chat can't loop forever.
 */
async function loadLatestWindow(client: Client, jid: string): Promise<void> {
  let prevNewest = (await getNewestBrowserMsgTs(client, jid)) ?? -Infinity;
  let stableRounds = 0;
  for (let i = 0; i < MAX_LATEST_ROUNDS && stableRounds < 2; i++) {
    await triggerLatestLoad(client, jid);
    await sleep(POLL_INTERVAL_MS);
    const newest = (await getNewestBrowserMsgTs(client, jid)) ?? -Infinity;
    if (newest > prevNewest) {
      prevNewest = newest;
      stableRounds = 0;
    } else {
      stableRounds += 1;
    }
  }
}

/** Return the timestamp of the oldest message currently in the browser's store. */
async function getOldestBrowserMsgTs(client: Client, jid: string): Promise<number | null> {
  const page = client.pupPage;
  if (!page) return null;

  return (page as any).evaluate((chatId: string) => {
    const w = window as any;
    try {
      const chatWid = w.Store.WidFactory.createWid(chatId);
      const chat = w.Store.Chat.get(chatWid);
      const msgs: any[] = chat?.msgs?.getModelsArray() ?? [];
      if (!msgs.length) return null;
      return msgs.reduce((min, m) => {
        const t = m.t ?? m.messageTimestamp ?? null;
        return t !== null && t < min ? t : min;
      }, Infinity) as number;
    } catch (_) {
      return null;
    }
  }, jid);
}

/** Return how many messages are currently in the browser's store for this chat. */
async function getChatMsgCount(client: Client, jid: string): Promise<number> {
  const page = client.pupPage;
  if (!page) return 0;

  return (page as any).evaluate((chatId: string) => {
    const w = window as any;
    try {
      const chatWid = w.Store.WidFactory.createWid(chatId);
      const chat = w.Store.Chat.get(chatWid);
      return chat?.msgs?.getModelsArray()?.length ?? 0;
    } catch (_) {
      return 0;
    }
  }, jid);
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

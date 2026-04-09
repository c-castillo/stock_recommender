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
import type { Client, Message } from "whatsapp-web.js";

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

export async function startSyncJob(groups: GroupInput[]): Promise<SyncJob> {
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
/** consecutive polls with no growth before we consider history exhausted */
const MAX_STABLE_ROUNDS = 4;
/** hard page limit per group */
const MAX_PAGES = 100;
/** only sync messages from the last N days */
const SYNC_DAYS = 7;

// ── Internal runner ───────────────────────────────────────────────────────────

async function runJob(job: SyncJob) {
  const client = getClient();
  if (!client) {
    job.status = "error";
    job.completedAt = Date.now();
    return;
  }

  for (const gp of job.groups) {
    upsertGroup(gp.jid, gp.name);

    try {
      gp.status = "fetching";

      // Hard cutoff: only sync the last SYNC_DAYS days (unix seconds).
      const cutoffTs = Math.floor(Date.now() / 1000) - SYNC_DAYS * 86400;

      // Cursor: timestamp of the newest message already stored for this group.
      // Used to stop the pagination loop once the browser has loaded messages
      // older than what we already have, and to skip processing known messages.
      const newestStored = getNewestMessage(gp.jid);
      const newestStoredTs = newestStored?.ts ?? null;

      // ── Phase 1: load history into the browser store ────────────────────
      let loadedCount = await getChatMsgCount(client, gp.jid);
      let stableRounds = 0;

      while (loadedCount < MAX_MESSAGES && stableRounds < MAX_STABLE_ROUNDS && gp.page < MAX_PAGES) {
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

        // Early stop: browser has gone back past the 7-day cutoff.
        if (oldestBrowserTs !== null && oldestBrowserTs < cutoffTs) break;

        // Early stop: if the browser store now contains messages older than
        // our newest stored record, we've fully covered the gap — no need to
        // paginate further back.
        if (newestStoredTs !== null && oldestBrowserTs !== null && oldestBrowserTs <= newestStoredTs) break;
      }

      // ── Phase 2: retrieve all messages now in the store ────────────────
      gp.status = "processing";
      const chat = await client.getChatById(gp.jid);
      // Pass exact count so fetchMessages skips its loadEarlierMsgs loop.
      const messages: Message[] = await chat.fetchMessages({ limit: Math.max(loadedCount, 1) });

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
      gp.error = String(err);
    }
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

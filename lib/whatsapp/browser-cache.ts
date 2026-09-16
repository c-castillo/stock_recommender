/**
 * Chromium profile hygiene.
 *
 * The Puppeteer user-data dir grows without bound: after a few months of daily
 * syncs it was measured at 2.6 GB, of which ~2 GB was pure asset cache —
 * Default/Cache (1.0 GB), Service Worker/CacheStorage (747 MB) and
 * Default/Code Cache (257 MB). Chromium opens, indexes and validates all of it
 * during startup, which is the single largest component of a slow connect().
 *
 * None of those directories hold state we need: the WhatsApp session lives in
 * Local Storage + IndexedDB, and everything pruned here is re-fetched from the
 * network on the next page load. IndexedDB is NEVER touched — it holds both the
 * auth keys and the message store, so wiping it logs the user out and forces a
 * full history re-sync.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";

/** Caches that are safe to delete: re-created from the network on next load. */
const DISPOSABLE = [
  "Default/Cache",
  "Default/Code Cache",
  // The WHOLE Service Worker directory — registration DB, script cache and
  // CacheStorage together. Deleting only CacheStorage (as this first did) left
  // WhatsApp Web registered with a service worker whose app-shell cache was
  // empty; the page then never fired `load`, and whatsapp-web.js's
  // page.goto(..., { waitUntil: "load", timeout: 0 }) hung forever with the
  // client stuck at "connecting" and no error. Removing the registration too
  // makes the browser re-register from the network, which is what the
  // browser's own "clear site data" does.
  "Default/Service Worker",
  "Default/GPUCache",
  "Default/DawnWebGPUCache",
  "Default/DawnGraphiteCache",
  "GrShaderCache",
  "ShaderCache",
];

/** Prune once the disposable caches exceed this. Below it the cache is doing
 *  its job (faster loads) and clearing it would cost more than it saves. */
const CACHE_BUDGET_BYTES = 400 * 1024 * 1024;

/**
 * Total size of `dir`, giving up as soon as `limit` is exceeded.
 *
 * The early exit matters: a full recursive stat of a 2 GB profile is itself
 * slow enough to eat the win. Once we know we're over budget the exact figure
 * is irrelevant — we're deleting it either way.
 */
async function sizeAtMost(dir: string, limit: number): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(stack.pop()!, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(e.parentPath, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        try {
          total += (await fsp.stat(p)).size;
        } catch {
          /* vanished mid-walk */
        }
        if (total > limit) return total;
      }
    }
  }
  return total;
}

/**
 * Delete Chromium's disposable caches if they have grown past the budget.
 *
 * MUST be called with no browser attached to the profile — connect() only
 * reaches here when there is no live client. Returns the bytes freed (0 when
 * the profile was already within budget, which is the common case once the
 * --disk-cache-size cap is in effect).
 */
export async function pruneBrowserCache(sessionDir: string): Promise<number> {
  // LocalAuth nests the profile one level down.
  const profile = path.join(sessionDir, "session");
  const roots = [profile, sessionDir].filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  if (!roots.length) return 0;

  const targets = roots.flatMap((r) => DISPOSABLE.map((d) => path.join(r, d)));

  let seen = 0;
  for (const t of targets) {
    seen += await sizeAtMost(t, CACHE_BUDGET_BYTES - seen);
    if (seen > CACHE_BUDGET_BYTES) break;
  }
  if (seen <= CACHE_BUDGET_BYTES) return 0;

  // Async throughout: deleting ~2 GB takes seconds, and the synchronous fs
  // calls would stall every other request this Next server is handling.
  let freed = 0;
  for (const t of targets) {
    try {
      const before = await sizeAtMost(t, Number.MAX_SAFE_INTEGER);
      await fsp.rm(t, { recursive: true, force: true });
      freed += before;
    } catch {
      /* in use or already gone — skip */
    }
  }
  if (freed > 0) {
    console.log(
      `[whatsapp] pruned ${(freed / 1024 / 1024).toFixed(0)} MB of Chromium cache`
    );
  }
  return freed;
}

/**
 * Keep only the newest `keep` cached WhatsApp Web index.html files.
 *
 * whatsapp-web.js writes one ~600 KB file per WhatsApp release and never
 * removes the old ones (131 files / 68 MB when measured). Only the current
 * version is ever read back, so the rest is dead weight — and when the cache
 * sits inside the project it also lands in Turbopack's watch scope.
 */
export function pruneWebVersionCache(dir: string, keep = 3): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
  } catch {
    return;
  }
  if (files.length <= keep) return;

  const byAge = files
    .map((f) => {
      const p = path.join(dir, f);
      try {
        return { p, mtime: fs.statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { p: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);

  for (const { p } of byAge.slice(keep)) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * One-time move of the newest cached index.html files from the legacy
 * ./.wwebjs_cache in the project cwd to `to`.
 *
 * Without this the first connect after the relocation finds an empty cache and
 * has to re-download the ~600 KB WhatsApp Web bundle before it can even show a
 * QR code. Only the newest few are worth carrying over — older versions are
 * never requested.
 */
export function migrateWebVersionCache(from: string, to: string, keep = 3): void {
  let files: string[];
  try {
    files = fs.readdirSync(from).filter((f) => f.endsWith(".html"));
  } catch {
    return; // no legacy cache — nothing to do
  }
  if (!files.length) return;

  try {
    if (fs.readdirSync(to).some((f) => f.endsWith(".html"))) return; // already migrated
  } catch {
    return;
  }

  const newest = files
    .map((f) => {
      try {
        return { f, mtime: fs.statSync(path.join(from, f)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { f: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, keep);

  for (const { f } of newest) {
    try {
      fs.copyFileSync(path.join(from, f), path.join(to, f));
    } catch {
      /* ignore */
    }
  }
  // Reclaim the whole legacy directory — it is out of Turbopack's way only
  // once it is actually gone.
  try {
    fs.rmSync(from, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

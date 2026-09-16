// TEMP diagnostic: replicate client.ts's Client and time every phase.
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import path from "path";
import os from "os";

const SESSION_DIR = path.join(os.homedir(), ".stock-recommender-wa");
const WEB_CACHE_DIR = path.join(SESSION_DIR, "web-cache");
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const c = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  webVersionCache: { type: "local", path: WEB_CACHE_DIR },
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disk-cache-size=104857600",
      "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling", "--disable-dev-shm-usage", "--disable-gpu",
      "--disable-extensions", "--disable-component-update", "--disable-background-networking",
      "--disable-sync", "--no-first-run", "--no-default-browser-check", "--mute-audio",
    ],
  },
});

for (const ev of ["qr", "authenticated", "ready", "auth_failure", "disconnected", "change_state", "loading_screen"]) {
  c.on(ev, (...a) => log("EVENT", ev, String(a[0] ?? "").slice(0, 60)));
}

setInterval(async () => {
  try {
    const p = c.pupPage;
    if (!p) return log("poll: no page yet");
    const r = await Promise.race([
      p.evaluate(() => JSON.stringify({
        keys: Object.keys(window).filter((k) => /^on[A-Z]/.test(k)).length,
        last: Object.keys(window).filter((k) => /^on[A-Z]/.test(k)).pop(),
        synced: (() => { try { return window.require("WAWebSocketModel").Socket.hasSynced; } catch { return null; } })(),
      })),
      new Promise((r) => setTimeout(() => r("EVALUATE_HUNG"), 4000)),
    ]);
    log("poll:", r);
  } catch (e) { log("poll err", String(e).slice(0, 100)); }
}, 5000);

log("initialize()");
c.initialize().then(() => log("initialize resolved")).catch((e) => log("initialize rejected", e));

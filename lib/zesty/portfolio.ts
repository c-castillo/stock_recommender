/**
 * Fetches the live portfolio from Zesty Finance using Puppeteer.
 * Logs in via Auth0 and intercepts the /api/positions response.
 *
 * Auth flow:
 *  1. goto /auth/login  →  redirected to auth.zestyfinance.com
 *  2. #username + submit
 *  3. #password + submit  →  redirected to passkey-enrollment
 *  4. Click "Continúa sin claves de acceso" (2nd submit button)
 *     →  redirected through /auth/callback?code=… → /dashboard/us
 *  5. Intercept /api/positions?market=us and /api/accounts/balance?market=us
 *  6. Ask /api/orders/pending and /api/orders from inside the session
 */

import puppeteer from "puppeteer";
import { readKnownLegs, recordLegOutcome } from "@/lib/zesty/legs";

/**
 * The stop legs of oto/bracket buys, as rows shaped like the pending list's.
 *
 * Zesty's web API lists only the parent: a filled buy stays in the pending
 * list while its stop leg rests, but the leg itself is absent, and the order
 * detail does not link to it. A leg can be read by its own id, which only the
 * confirmation that placed the order returns, so those ids are kept in
 * `.whatsapp/zesty-legs.json`. A parent with no known leg still proves a stop
 * rests; it is listed with its level unknown.
 */
async function legRows(
  pending: unknown[],
  ask: (path: string) => Promise<unknown>
): Promise<Record<string, unknown>[]> {
  const known = readKnownLegs();
  const rows: Record<string, unknown>[] = [];
  for (const item of pending) {
    const p = item as Record<string, unknown>;
    const parentId = String(p.orderId ?? "");
    if (String(p.side) !== "buy" || !/complet|ejecutad|filled/i.test(String(p.status ?? ""))) continue;
    const legs = known[parentId] ?? [];
    if (legs.length === 0) {
      rows.push({
        orderId: `${parentId}:stop`, symbol: p.symbol, side: "sell", type: "stop", qty: p.qty,
        stopPrice: null, status: "Pendiente", createdAt: p.createdAt, timeInForce: "gtc", filledQty: 0,
      });
      continue;
    }
    for (const leg of legs) {
      const detail = (await ask(`/api/orders/${leg.legId}?market=us`)) as Record<string, unknown> | null;
      rows.push({
        orderId: leg.legId, symbol: p.symbol, side: leg.side, type: leg.type, qty: leg.qty,
        stopPrice: leg.stopPrice, limitPrice: leg.limitPrice ?? null,
        status: detail?.status ?? "Pendiente", createdAt: p.createdAt, timeInForce: "gtc",
        filledQty: Number(detail?.filledQty ?? 0),
        filledAvgPrice: Number(detail?.filledQty ?? 0) > 0 && detail?.subtotal
          ? Number(detail.subtotal) / Number(detail.filledQty) : null,
      });
    }
  }
  return rows;
}

/**
 * Settle the known legs whose parent left the pending list: the leg filled
 * (the stop closed the position) or ended with its parent. Read each by id
 * and keep the outcome in the legs file, where the trade journal finds the
 * sale. The web API gives no fill time, so a fill is dated by this read.
 */
async function settleLegs(pending: unknown[], ask: (path: string) => Promise<unknown>): Promise<void> {
  const stillPending = new Set(pending.map((p) => String((p as Record<string, unknown>).orderId ?? "")));
  for (const [parentId, legs] of Object.entries(readKnownLegs())) {
    if (stillPending.has(parentId)) continue;
    for (const leg of legs) {
      if (leg.done) continue;
      const detail = (await ask(`/api/orders/${leg.legId}?market=us`)) as Record<string, unknown> | null;
      if (!detail) continue;
      const filled = Number(detail.filledQty ?? 0);
      if (filled > 0) {
        recordLegOutcome(leg.legId, {
          filledQty: filled,
          filledAvgPrice: detail.subtotal ? Number(detail.subtotal) / filled : Number(detail.filledAvgPrice) || null,
          filledAt: new Date().toISOString(),
        });
      } else if (/cancel|expir|vencid|rechaz|reject/i.test(String(detail.status ?? ""))) {
        recordLegOutcome(leg.legId, { ended: true });
      }
    }
  }
}

export interface ZestyData {
  positions: unknown[];
  /** Total cash, including what open buy orders have reserved. */
  cashBalance: number | null;
  /** Cash free for a new order: total cash less open buy orders. */
  buyingPower: number | null;
  /** Orders working at the broker, or null when the request failed. */
  openOrders: unknown[] | null;
  /** Orders that ended: filled, cancelled, expired or rejected. */
  closedOrders: unknown[] | null;
}

export async function fetchZestyData(
  /** Ids of closed orders already on record: paging stops at the first page
   *  that holds one, so a daily sync reads one page instead of the whole history. */
  knownOrderIds: Set<string> = new Set()
): Promise<ZestyData> {
  const email = process.env.ZESTY_EMAIL;
  const password = process.env.ZESTY_PASSWORD;

  if (!email || !password) {
    throw new Error("ZESTY_EMAIL y ZESTY_PASSWORD deben estar en .env.local");
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
    ],
  });
  const page = await browser.newPage();

  try {
    // ── Intercept API responses ─────────────────────────────────────────────
    // The listener must be attached before any navigation so it survives
    // all redirects and the final SPA load.
    let capturedPositions: unknown[] | null = null;
    let capturedBalance: number | null = null;
    let capturedBuyingPower: number | null = null;
    const observedApiUrls: string[] = [];

    page.on("response", async (res) => {
      const url = res.url();
      if (url.includes("/api/")) observedApiUrls.push(url);
      try {
        if (url.includes("/api/positions") && capturedPositions === null) {
          const json = await res.json();
          capturedPositions = Array.isArray(json)
            ? json
            : (json?.data ?? json?.positions ?? [json]);
        }
        if (url.includes("/api/accounts/balance") && capturedBalance === null) {
          const json = (await res.json()) as Record<string, unknown>;
          const body = (json?.data as Record<string, unknown> | undefined) ?? json;
          // An open buy order lowers buyingPower but not cash. Book value needs
          // cash; a new order needs buyingPower. Reading only buyingPower made
          // the book look $574 poorer for as long as a limit order was working.
          const power = parseFloat(String(body?.buyingPower));
          const total = parseFloat(String(body?.cash));
          if (!isNaN(power)) capturedBuyingPower = power;
          if (!isNaN(total)) capturedBalance = total;
          else if (!isNaN(power)) capturedBalance = power;
        }
      } catch {
        // ignore non-JSON / already-consumed responses
      }
    });

    // ── Step 1: Login page ──────────────────────────────────────────────────
    await page.goto("https://trade.zestyfinance.com/auth/login", {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    // ── Step 2: Auth0 username step ─────────────────────────────────────────
    await page.waitForSelector("#username", { timeout: 10_000 });
    await page.type("#username", email);
    // Submitting the identifier triggers a full navigation to the password
    // page. Wait for it so we don't query the about-to-be-torn-down DOM.
    await Promise.all([
      page
        .waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 })
        .catch(() => {}),
      page.click('button[type="submit"][name="action"]'),
    ]);

    // ── Step 3: Auth0 password step ─────────────────────────────────────────
    // Match by input type as well as id: the password field must be present
    // AND visible (rendered after the transition) before we type into it.
    const PASSWORD_SELECTOR = '#password, input[type="password"]';
    await page.waitForSelector(PASSWORD_SELECTOR, {
      visible: true,
      timeout: 15_000,
    });
    await page.type(PASSWORD_SELECTOR, password);
    // After this click, Auth0 POSTs and redirects to passkey-enrollment
    await page.click('button[type="submit"][name="action"]');

    // Wait until we've navigated away from the password page
    // (to either passkey-enrollment or directly to trade app)
    await page.waitForFunction(
      () =>
        !window.location.href.includes("/u/login/password") &&
        !window.location.href.includes("/u/login/identifier"),
      { timeout: 30_000, polling: 300 }
    );

    // ── Step 4: Handle passkey enrollment ───────────────────────────────────
    if (page.url().includes("passkey")) {
      // Auth0 renders two submit buttons on the passkey-enrollment page:
      //   [0] "Crea una clave de acceso"       ← we do NOT want this
      //   [1] "Continúa sin claves de acceso"  ← click this to skip
      // The skip button also carries the class fragment "abort-passkey".
      const submitBtns = await page.$$('button[type="submit"][name="action"]');

      const skipBtn =
        // Prefer the Auth0 abort-passkey class (more reliable than position)
        await page.$('[class*="abort-passkey"]') ??
        // Fall back to the second submit button
        (submitBtns.length >= 2 ? submitBtns[1] : null) ??
        // Last resort: the only button, if it has skip-like text
        (submitBtns.length === 1 ? submitBtns[0] : null);

      if (skipBtn) {
        // Click skip and wait until we leave the Auth0 domain
        await skipBtn.click();
        await page.waitForFunction(
          () => window.location.hostname !== "auth.zestyfinance.com",
          { timeout: 30_000, polling: 300 }
        );
      } else {
        // No skip button found — navigate directly (session cookie is already set)
        await page
          .goto("https://trade.zestyfinance.com/dashboard/us", {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          })
          .catch((err: Error) => {
            if (!err.message.includes("ERR_ABORTED")) throw err;
          });
      }
    }

    // ── Step 5: Wait for the SPA to finish the OAuth code exchange ──────────
    // After the /auth/callback?code=… redirect the SPA consumes the code and
    // removes it from the URL.  Only then is the session fully active.
    await page.waitForFunction(
      () =>
        window.location.hostname === "trade.zestyfinance.com" &&
        !window.location.search.includes("code="),
      { timeout: 30_000, polling: 300 }
    );

    // ── Step 6: Navigate to the US dashboard ────────────────────────────────
    if (!page.url().includes("/dashboard/us")) {
      await page
        .goto("https://trade.zestyfinance.com/dashboard/us", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        })
        .catch((err: Error) => {
          if (!err.message.includes("ERR_ABORTED")) throw err;
        });
    }

    // ── Step 7: Wait for /api/positions AND /api/accounts/balance ───────────
    // The dashboard SPA fires both on initial load, but the order is
    // non-deterministic — wait for positions (required) first, then give
    // balance a short extra window before returning.
    await pollUntil(() => capturedPositions !== null, 30_000);

    if (capturedPositions === null) {
      // Some SPAs lazy-load; a reload re-triggers all dashboard API calls.
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await pollUntil(() => capturedPositions !== null, 30_000);
    }

    if (capturedPositions === null) {
      throw new Error(
        `No se capturó /api/positions — /api/ calls observed: [${
          observedApiUrls.join(", ") || "none"
        }]`
      );
    }

    // Give balance up to 5 extra seconds if it hasn't arrived alongside positions
    if (capturedBalance === null) {
      await pollUntil(() => capturedBalance !== null, 5_000).catch(() => {
        // Non-fatal: balance is optional, positions are what matter
      });
    }

    // ── Step 8: Orders ──────────────────────────────────────────────────────
    // The dashboard does not load them, but the session can ask: the open
    // orders (resting stops, working limits) and the closed ones (fills,
    // expiries, cancellations). Non-fatal: the book is what must not fail.
    const ask = (path: string) =>
      page
        .evaluate(async (u) => {
          const r = await fetch(u, { credentials: "include" });
          return r.ok ? await r.json() : null;
        }, path)
        .catch(() => null);
    const list = (j: unknown): unknown[] | null =>
      Array.isArray(j) ? j : Array.isArray((j as { data?: unknown })?.data) ? ((j as { data: unknown[] }).data) : null;
    const openOrders = list(await ask("/api/orders/pending?market=us"));
    if (openOrders) {
      await settleLegs(openOrders, ask);
      openOrders.push(...(await legRows(openOrders, ask)));
    }
    // The history comes a page at a time. Entry dates are read from it, so
    // follow the cursor back as far as it goes (bounded, in case it loops).
    let closedOrders: unknown[] | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < 80; page++) {
      const json: unknown = await ask(
        `/api/orders?market=us${cursor ? `&nextToken=${encodeURIComponent(cursor)}` : ""}`
      );
      const rows = list(json);
      if (!rows) break;
      closedOrders = [...(closedOrders ?? []), ...rows];
      const next = (json as { nextToken?: unknown; next_token?: unknown } | null)?.nextToken ??
        (json as { next_token?: unknown } | null)?.next_token;
      if (typeof next !== "string" || !next || next === cursor || rows.length === 0) break;
      if (rows.some((r) => knownOrderIds.has(String((r as { orderId?: unknown })?.orderId)))) break;
      cursor = next;
    }

    return {
      positions: capturedPositions,
      cashBalance: capturedBalance,
      buyingPower: capturedBuyingPower,
      openOrders,
      closedOrders,
    };
  } finally {
    await browser.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pollUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() >= deadline)
        return reject(new Error(`Timed out after ${timeoutMs}ms`));
      setTimeout(tick, 300);
    };
    tick();
  });
}

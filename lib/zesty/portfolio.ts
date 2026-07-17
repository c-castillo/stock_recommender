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
 */

import puppeteer from "puppeteer";

export interface ZestyData {
  positions: unknown[];
  cashBalance: number | null;
}

export async function fetchZestyData(): Promise<ZestyData> {
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
          const raw =
            json?.buyingPower ??
            (json?.data as Record<string, unknown> | undefined)?.buyingPower;
          const n = parseFloat(String(raw));
          if (!isNaN(n)) capturedBalance = n;
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

    return { positions: capturedPositions, cashBalance: capturedBalance };
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

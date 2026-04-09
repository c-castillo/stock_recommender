/**
 * Fetches the live portfolio from Zesty Finance using Puppeteer.
 * Logs in via Auth0 and intercepts the /api/positions?market=us response.
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

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    let positionsData: unknown[] | null = null;
    let cashBalance: number | null = null;

    page.on("response", async (response) => {
      const url = response.url();
      try {
        if (url.includes("/api/positions") && url.includes("market=us")) {
          const json = await response.json();
          positionsData = Array.isArray(json) ? json : (json?.data ?? json?.positions ?? [json]);
        }
        if (url.includes("/api/accounts/balance") && url.includes("market=us")) {
          const json = await response.json() as Record<string, unknown>;
          // Try common field names for the cash/available balance
          const raw =
            json?.buyingPower ??
            (json?.data as Record<string, unknown> | undefined)?.buyingPower;
          const n = parseFloat(String(raw));
          if (!isNaN(n)) cashBalance = n;
        }
      } catch {
        // ignore parse errors
      }
    });

    // Go to login
    await page.goto("https://trade.zestyfinance.com/auth/login", {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    // Fill Auth0 form
    await page.waitForSelector("#username", { timeout: 10_000 });
    await page.type("#username", email);
    await page.type("#password", password);
    await page.click('button[type="submit"][name="action"]');

    // Wait for redirect back to the dashboard
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 });

    // Navigate to the US dashboard — this triggers both /api/positions and /api/accounts/balance
    await page.goto("https://trade.zestyfinance.com/dashboard/us", {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    // Give a moment for any pending XHRs
    if (!positionsData || cashBalance === null) {
      await new Promise((r) => setTimeout(r, 3_000));
    }

    if (!positionsData) {
      throw new Error("No se capturó la respuesta de /api/positions?market=us");
    }

    return { positions: positionsData, cashBalance };
  } finally {
    await browser.close();
  }
}

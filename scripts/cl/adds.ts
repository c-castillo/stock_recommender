/**
 * The Chilean ADD ledger (`.whatsapp/cl/adds.json`).
 *
 *   pnpm exec tsx scripts/cl/adds.ts list
 *   pnpm exec tsx scripts/cl/adds.ts record TICKER --entry 4830 --on 2026-10-19 --note "…" [--invalidation 4500]
 *   pnpm exec tsx scripts/cl/adds.ts deactivate TICKER
 *
 * `record` on a ticker already in the ledger is a refresh: it re-dates the row
 * and replaces the entry, and keeps the old note after the new one, so the
 * age restarts from the main analyst's latest buy (as in the US ledger).
 */
import { loadClLedger, saveClLedger } from "@/lib/cl/ledger";

const [cmd, raw, ...rest] = process.argv.slice(2);
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const adds = loadClLedger();

if (cmd === "list" || !cmd) {
  if (!adds.length) console.log("The Chilean ADD ledger is empty.");
  for (const a of adds)
    console.log(`${a.active ? "●" : "○"} ${a.ticker} · ${a.addedOn} · entry ${a.entryPrice ?? "—"} · invalidation ${a.invalidation ?? "—"} · ${a.note ?? ""}`);
} else if (cmd === "record" && raw) {
  const ticker = raw.toUpperCase();
  const addedOn = opt("on") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(addedOn)) throw new Error(`--on must be YYYY-MM-DD, got ${addedOn}`);
  const inv = opt("invalidation");
  const old = adds.find((a) => a.ticker === ticker);
  const row = {
    ticker,
    entryPrice: opt("entry") ?? old?.entryPrice ?? null,
    addedOn,
    note: [opt("note"), old?.note].filter(Boolean).join(" · ") || null,
    invalidation: inv != null ? Number(inv) : (old?.invalidation ?? null),
    active: true,
  };
  saveClLedger([row, ...adds.filter((a) => a.ticker !== ticker)]);
  console.log(`${old ? "Refreshed" : "Recorded"} ${ticker} (${addedOn}).`);
} else if (cmd === "deactivate" && raw) {
  const ticker = raw.toUpperCase();
  if (!adds.some((a) => a.ticker === ticker)) throw new Error(`${ticker} is not in the ledger`);
  saveClLedger(adds.map((a) => (a.ticker === ticker ? { ...a, active: false } : a)));
  console.log(`Deactivated ${ticker}.`);
} else {
  console.error("usage: adds.ts list | record TICKER [--entry X] [--on YYYY-MM-DD] [--note …] [--invalidation X] | deactivate TICKER");
  process.exit(2);
}

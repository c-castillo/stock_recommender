/**
 * The CMF filings of the Chilean book's names (`lib/cl/cmf.ts`).
 *
 *   pnpm exec tsx scripts/cl/cmf.mts sync [TICKER …]   # held + active ADDs when none is given
 *   pnpm exec tsx scripts/cl/cmf.mts show TICKER [--days 90]
 *
 * `sync` also stores the latest period's statements (XBRL) and last
 * December's, which the bundle's "Financial statements" section reads.
 *
 * `sync` exits 0 when every name synced, 1 when some failed (the others are
 * kept), so the preflight can go on with what is stored.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CL_HOLDINGS, CL_WATCHLIST } from "@/lib/cl/config";
import {
  CMF_DIR, CMF_ISSUER, isDividendNotice, loadCmfIndex, nextDuePeriod, noticeBody, saveCmfIndex, syncIssuer,
} from "@/lib/cl/cmf";
import type { ClStatement } from "@/lib/cl/holdings";
import { loadClLedger } from "@/lib/cl/ledger";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Santiago" });

function bookNames(): string[] {
  const files = existsSync(CL_HOLDINGS) ? readdirSync(CL_HOLDINGS).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
  const held = files.length
    ? (JSON.parse(readFileSync(join(CL_HOLDINGS, files.at(-1)!), "utf8")) as ClStatement).positions.map((p) => p.ticker)
    : [];
  return [...new Set([...held, ...loadClLedger().filter((a) => a.active).map((a) => a.ticker), ...Object.keys(CL_WATCHLIST)])];
}

if (cmd === "sync") {
  const asked = rest.filter((a) => !a.startsWith("--")).map((t) => t.toUpperCase());
  const tickers = asked.length ? asked : bookNames();
  const index = loadCmfIndex();
  const unknown = tickers.filter((t) => !CMF_ISSUER[t]);
  const failed: string[] = [];
  // One issuer at a time: the CMF's site is slow and a burst gets refused.
  for (const t of tickers.filter((x) => CMF_ISSUER[x])) {
    try {
      const r = await syncIssuer(t, index[t], TODAY);
      index[t] = r;
      const recent = r.notices.filter((n) => n.at.slice(0, 10) >= new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
      const next = nextDuePeriod(r.calendar, TODAY);
      console.log(`${t}: ${r.notices.length} notices in the year (${recent.length} in 30 days, ${r.notices.filter(isDividendNotice).length} on dividends)` +
        ` · latest statements ${r.report?.period ?? "—"}${r.report && !r.report.text ? " (no análisis razonado)" : ""}` +
        `${r.report ? (r.statements ? ` · XBRL${r.december ? " + December" : ""}` : " · no XBRL") : ""}` +
        ` · next due ${next ? `${next.due} (${next.year}-${next.month})` : "not set"}`);
    } catch (e) {
      failed.push(t);
      if (index[t]) index[t].error = String((e as Error).message ?? e);
      console.log(`${t}: ⚠ ${(e as Error).message ?? e} — kept what was stored`);
    }
    saveCmfIndex(index);
  }
  if (unknown.length) console.log(`No CMF id for: ${unknown.join(", ")} (add it to CMF_ISSUER in lib/cl/cmf.ts).`);
  process.exit(failed.length ? 1 : 0);
} else if (cmd === "show" && rest[0]) {
  const t = rest[0].toUpperCase();
  const r = loadCmfIndex()[t];
  if (!r) {
    console.log(`${t} has not been synced: run \`pnpm exec tsx scripts/cl/cmf.mts sync ${t}\`.`);
    process.exit(1);
  }
  const since = new Date(Date.now() - Number(opt("days") ?? 90) * 86_400_000).toISOString().slice(0, 10);
  console.log(`${t} · RUT ${r.rut} · synced ${r.syncedAt.slice(0, 16)}`);
  for (const n of r.notices.filter((x) => x.at.slice(0, 10) >= since || isDividendNotice(x))) {
    const body = !n.text ? "(text not downloaded)"
      : n.scanned ? `(scanned, OCR could not read it: read the PDF ${join(CMF_DIR, n.text)})`
      : noticeBody(readFileSync(join(CMF_DIR, n.text), "utf8"));
    console.log(`\n[${n.at}] ${n.materia}${isDividendNotice(n) ? " · DIVIDEND" : ""}${n.ocr ? " · OCR" : ""} · doc ${n.doc}\n${body}`);
  }
  if (r.report?.text) console.log(`\nAnálisis razonado ${r.report.period}: ${join(CMF_DIR, r.report.text)}`);
} else {
  console.log("usage: cmf.mts sync [TICKER …] | show TICKER [--days N]");
  process.exit(2);
}

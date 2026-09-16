/**
 * CLI: backfill the Dr CS ADD ledger from ADDs already sitting in the corpus.
 *
 * Ingestion now writes every "+TICKER" through to `dr_cs_adds`, but messages
 * stored before that change only ever set the `dr_cs_add` flag. Those ADDs
 * expired out of the 7-day analysis window while the pipeline's own SELLs
 * persisted in wiki/ indefinitely — "+GLW 174" (Jul 15) and "+MU" (Jun 29)
 * both ended up carrying high-confidence SELLs the playbook forbids.
 *
 *   pnpm tsx scripts/backfill-dr-cs-adds.ts          # dry run, prints a table
 *   pnpm tsx scripts/backfill-dr-cs-adds.ts --apply  # write the rows
 *
 * Two safety rules:
 *  - Existing ledger rows are never touched (recordDrCsAddIfNew is DO NOTHING),
 *    so hand-curated notes, corrected entries and deliberate deactivations win.
 *  - Only ADDs newer than ACTIVE_MAX_AGE_DAYS land active. An ADD from months
 *    ago would otherwise switch on the "≥85 confidence, never SELL" override
 *    for a name whose trend has long since rolled over. Older ones are recorded
 *    inactive: on the books, reviewable, not steering the analysis.
 */

import { listDrCsAddMessages, parseDrCsAdds, recordDrCsAddIfNew } from "@/lib/whatsapp/db";

/** ADDs older than this are recorded but left inactive. */
const ACTIVE_MAX_AGE_DAYS = 90;

interface Candidate {
  ticker: string;
  entryPrice: string | null;
  addedOn: string;
  ageDays: number;
  body: string;
}

function collect(): Candidate[] {
  const rows = listDrCsAddMessages();

  // Newest occurrence per ticker wins — iterate oldest-first and overwrite.
  const byTicker = new Map<string, Candidate>();
  const now = Date.now();

  for (const r of rows) {
    const addedOn = new Date(r.ts * 1000).toISOString().slice(0, 10);
    const ageDays = Math.floor((now - r.ts * 1000) / 86_400_000);
    for (const { ticker, entryPrice } of parseDrCsAdds(r.body)) {
      byTicker.set(ticker, {
        ticker,
        entryPrice,
        addedOn,
        ageDays,
        body: (r.body ?? "").split("\n")[0].slice(0, 40),
      });
    }
  }

  return [...byTicker.values()].sort((a, b) => a.ageDays - b.ageDays);
}

function main() {
  const apply = process.argv.includes("--apply");
  const candidates = collect();

  if (candidates.length === 0) {
    console.log("No ADDs found in the corpus.");
    return;
  }

  console.log(apply ? "APPLYING\n" : "DRY RUN — pass --apply to write\n");
  console.log("Ticker  Entry   Added        Age    Active  Result");
  console.log("------  ------  -----------  -----  ------  ------------------");

  let written = 0;
  for (const c of candidates) {
    const active = c.ageDays <= ACTIVE_MAX_AGE_DAYS;
    let result: string;
    if (apply) {
      const inserted = recordDrCsAddIfNew({
        ticker: c.ticker,
        entryPrice: c.entryPrice,
        addedOn: c.addedOn,
        active,
        note: `backfill: "${c.body}"`,
      });
      if (inserted) written++;
      result = inserted ? "inserted" : "already in ledger (kept)";
    } else {
      result = "would insert";
    }
    console.log(
      `${c.ticker.padEnd(6)}  ${(c.entryPrice ?? "—").padEnd(6)}  ${c.addedOn}  ` +
        `${String(c.ageDays + "d").padEnd(5)}  ${(active ? "yes" : "no").padEnd(6)}  ${result}`
    );
  }

  if (apply) {
    console.log(`\n${written} row(s) inserted, ${candidates.length - written} left untouched.`);
    console.log("Review with the `dr_cs_adds` MCP tool; deactivate anything you disagree with.");
  }
}

main();

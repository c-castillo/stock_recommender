/**
 * CLI: delete provably contentless messages from the selected groups.
 *
 *   pnpm tsx scripts/prune-noise.ts            # dry run, counts + samples
 *   pnpm tsx scripts/prune-noise.ts --apply    # delete
 *
 * Deliberately narrow. Deletion is irreversible and WhatsApp cannot re-fetch
 * interior history, so this removes only what lib/whatsapp/noise.ts calls empty
 * by construction — the same definition the ingestion gate uses, so the two can
 * never drift. Judgement calls ("is this chatter or a thesis?") are NOT made
 * here; lib/ai/relevance.ts marks those instead, which is reversible.
 *
 * Hard protections, checked before any rule runs. A message is kept if it:
 *   - is flagged dr_cs_add, or
 *   - has media on disk or a cached digest (charts and PDFs are the corpus's
 *     highest-value content), or
 *   - contains a real ticker, validated against the SEC ticker universe, or
 *   - contains a price, percentage or finance keyword.
 */

import {
  listGroupJidsByName,
  listMessagesForPruning,
  deleteMessagesByIds,
  listGroups,
} from "@/lib/whatsapp/db";
import { PRUNABLE_GROUPS } from "@/lib/whatsapp/analysis-groups";
import { loadTickerUniverse } from "@/lib/market/filings";
import { classifyNoise } from "@/lib/whatsapp/noise";

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes("--apply");

  const universe = await loadTickerUniverse();
  if (universe.size === 0) {
    console.error(
      "Refusing to run: the SEC ticker universe failed to load, so real tickers " +
        "could not be protected. Retry when the network is available."
    );
    process.exitCode = 1;
    return;
  }
  console.log(`ticker universe: ${universe.size} symbols\n`);

  // Only groups explicitly marked prunable. USA Trading is exempt by design.
  const jids = listGroupJidsByName(PRUNABLE_GROUPS);
  const names = new Map(listGroups().map((g) => [g.jid, g.name]));
  console.log(`prunable groups: ${jids.map((j) => names.get(j) ?? j).join(", ") || "(none)"}`);
  console.log(`exempt: every other group, including USA Trading\n`);
  const rows = listMessagesForPruning(jids);

  const byRule = new Map<string, { n: number; samples: string[] }>();
  const doomed: string[] = [];

  for (const r of rows) {
    const v = classifyNoise(r.body, universe);
    if (!v.noise) continue;
    doomed.push(r.id);
    const slot = byRule.get(v.rule) ?? { n: 0, samples: [] };
    slot.n++;
    if (slot.samples.length < 6) slot.samples.push((r.body ?? "").replace(/\n/g, " ").slice(0, 60));
    byRule.set(v.rule, slot);
  }

  console.log(apply ? "APPLYING\n" : "DRY RUN — pass --apply to delete\n");
  console.log(`eligible (no media, no digest, no ADD): ${rows.length}`);
  console.log(`classified as noise:                    ${doomed.length}\n`);

  for (const [rule, { n, samples }] of [...byRule].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${String(n).padStart(5)}  ${rule}`);
    for (const s of samples) console.log(`         · ${JSON.stringify(s)}`);
  }

  if (!apply) {
    console.log("\nNothing deleted.");
    return;
  }

  const removed = deleteMessagesByIds(doomed);
  console.log(`\ndeleted ${removed} message(s).`);
}

main();

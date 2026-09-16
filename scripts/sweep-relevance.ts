/**
 * CLI: classify off-topic chatter in the prunable groups.
 *
 *   pnpm tsx --env-file=.env.local scripts/sweep-relevance.ts [batches]
 *
 * Marks wa_messages.relevance; deletes nothing. Runs automatically as Stage 0b
 * of every analysis, so this is for working down a backlog in one go.
 */

import { sweepRelevance } from "@/lib/ai/relevance";
import { listGroupJidsByName, relevanceStats } from "@/lib/whatsapp/db";
import { PRUNABLE_GROUPS } from "@/lib/whatsapp/analysis-groups";

async function main() {
  const batches = Number(process.argv[2] ?? 12);
  const jids = listGroupJidsByName(PRUNABLE_GROUPS);

  const before = relevanceStats(jids);
  console.log(`groups: ${PRUNABLE_GROUPS.join(", ")}`);
  console.log(`before: relevant=${before.relevant} noise=${before.noise} pending=${before.pending}`);

  const r = await sweepRelevance(batches);
  const after = relevanceStats(jids);

  console.log(`\nclassified ${r.classified}, marked noise ${r.markedNoise}, failed batches ${r.failedBatches}`);
  console.log(`after:  relevant=${after.relevant} noise=${after.noise} pending=${after.pending}`);
}

main();

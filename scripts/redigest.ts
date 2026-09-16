/**
 * CLI: regenerate media digests so they carry the current schema.
 *
 *   pnpm tsx --env-file=.env.local scripts/redigest.ts [days]           # dry run
 *   pnpm tsx --env-file=.env.local scripts/redigest.ts [days] --apply
 *
 * ensureMediaDigests only fills rows where media_digest IS NULL, so adding a
 * field to the digest schema (e.g. `demark`) never reaches already-digested
 * charts. This clears the window first, then re-runs the digest pass.
 *
 * Costs one Haiku call per chart/PDF in the window. Selected groups only.
 */

import { clearMediaDigests, countDigestedMedia } from "@/lib/whatsapp/db";
import { ensureMediaDigests } from "@/lib/ai/media-digest";

async function main() {
  const days = Number(process.argv[2] ?? 7);
  const apply = process.argv.includes("--apply");

  const n = countDigestedMedia(days);
  console.log(`digested media in the last ${days} day(s), selected groups: ${n}`);

  if (!apply) {
    console.log(`\nDRY RUN — pass --apply to clear and regenerate (${n} Haiku call(s)).`);
    return;
  }

  const cleared = clearMediaDigests(days);
  console.log(`cleared ${cleared} digest(s), regenerating...`);

  // ensureMediaDigests caps each pass at MAX_PER_RUN (40), so a single call
  // silently leaves the rest undigested. Loop until a pass produces nothing.
  let produced = 0;
  for (;;) {
    const n = await ensureMediaDigests(days);
    if (n === 0) break;
    produced += n;
    console.log(`  ...${produced}/${cleared}`);
  }

  console.log(`regenerated ${produced} digest(s).`);
  if (produced < cleared) {
    console.log(
      `${cleared - produced} could not be digested — unreadable or oversized ` +
        "files; they retry on the next analysis run."
    );
  }
}

main();

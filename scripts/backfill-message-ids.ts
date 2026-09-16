/**
 * CLI: give every NULL-id message a deterministic id, and drop the duplicates
 * that accumulated while ON CONFLICT could not fire.
 *
 *   pnpm tsx scripts/backfill-message-ids.ts [--apply]
 *
 * Legacy rows from the July 2026 WhatsApp id breakage. Until they are addressable
 * the relevance sweep silently no-ops on them and the pruner cannot remove them.
 */

import { listNullIdMessages, assignMessageId, dedupeSurrogateRows } from "@/lib/whatsapp/db";
import { surrogateMessageId } from "@/lib/whatsapp/msg-id";

function main() {
  const apply = process.argv.includes("--apply");
  const rows = listNullIdMessages();
  console.log(`${rows.length} message(s) with NULL id`);
  if (rows.length === 0) return;

  if (!apply) {
    for (const r of rows.slice(0, 5)) {
      console.log(`  ${surrogateMessageId(r)}  <- ${JSON.stringify((r.body ?? "").slice(0, 45))}`);
    }
    console.log("\nDRY RUN — pass --apply to write");
    return;
  }

  let assigned = 0;
  for (const r of rows) if (assignMessageId(r.rowid, surrogateMessageId(r))) assigned++;
  const removed = dedupeSurrogateRows();
  console.log(`assigned ${assigned} id(s), removed ${removed} duplicate row(s).`);
}

main();

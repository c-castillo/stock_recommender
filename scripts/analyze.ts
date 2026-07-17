/**
 * CLI: run the full investment analysis from the terminal.
 *
 * Drives the exact same pipeline as the web route (POST /api/analyze):
 * Stage 1 media digests → Stage 2 signals → Stage 3 Sonnet synthesis →
 * Haiku recommendation extraction. The narrative is streamed to stdout and the
 * structured recommendations are printed as a table at the end.
 *
 *   npm run analyze
 *
 * Requires ANTHROPIC_API_KEY (loaded from .env.local via `tsx --env-file`) and
 * must run from the repo root so the SQLite DB at .whatsapp/messages.db resolves.
 */

import { streamAnalysis, type AIRecommendation } from "@/lib/ai/analyze";

function printRecommendations(recs: AIRecommendation[]): void {
  if (recs.length === 0) {
    process.stdout.write("\n\n(No structured recommendations extracted.)\n");
    return;
  }

  process.stdout.write(`\n\n${"═".repeat(60)}\n`);
  process.stdout.write(`RECOMMENDATIONS (${recs.length})\n`);
  process.stdout.write(`${"═".repeat(60)}\n`);

  for (const r of recs) {
    const entry = r.entryPrice ?? "—";
    const target = r.priceTarget ?? "—";
    const stop = r.stopLoss ?? "—";
    process.stdout.write(
      `\n${r.action}  ${r.ticker} (${r.company}) · confidence ${r.confidence}\n` +
        `  entry ${entry} · target ${target} · stop ${stop} · mentions ${r.mentions}\n` +
        `  ${r.reasoning}\n` +
        (r.sources.length ? `  sources: ${r.sources.join(", ")}\n` : "")
    );
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY no está configurada. Asegúrate de tener .env.local."
    );
    process.exit(1);
  }

  let sawError = false;

  for await (const chunk of streamAnalysis()) {
    switch (chunk.type) {
      case "stats": {
        const s = chunk.stats!;
        process.stderr.write(
          `Analizando: ${s.textMessages} mensajes · ${s.images} imágenes · ` +
            `${s.documents} PDFs · ${s.groups.length} grupo(s)\n` +
            `${"─".repeat(60)}\n`
        );
        break;
      }
      case "text":
        process.stdout.write(chunk.content ?? "");
        break;
      case "recommendations":
        printRecommendations(chunk.recommendations ?? []);
        break;
      case "error":
        console.error(`\nError: ${chunk.error}`);
        sawError = true;
        break;
      case "done":
        process.stdout.write("\n");
        break;
    }
  }

  process.exit(sawError ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

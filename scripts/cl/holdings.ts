/**
 * Read an Itaú portfolio statement into the Chilean book.
 *
 *   pnpm exec tsx scripts/cl/holdings.ts <statement.pdf>   parse, store, file the PDF
 *   pnpm exec tsx scripts/cl/holdings.ts --latest          print the stored book
 *   pnpm exec tsx scripts/cl/holdings.ts <pdf> --if-newer  skip (exit 3) a statement older than the stored one
 *
 * Writes `.whatsapp/cl/holdings/<asOf>.json` and moves the PDF into
 * `.whatsapp/cl/statements/` (git-ignored: the statement carries the client's
 * name, RUT and address, and must never be committed). Exit code 1 when the
 * parse does not add up to the statement's own total.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { CL_HOLDINGS, CL_STATEMENTS } from "@/lib/cl/config";
import { checkStatement, parseStatement, statementText, type ClStatement } from "@/lib/cl/holdings";

const fmt = (n: number) => Math.round(n).toLocaleString("es-CL");

function show(s: ClStatement) {
  console.log(`Statement as of ${s.asOf}: ${s.positions.length} positions, ${s.funds.length} fund(s), total CLP ${fmt(s.totalValue)}`);
  for (const p of s.positions)
    console.log(`  ${p.ticker.padEnd(11)} ${String(p.shares).padStart(7)} sh  avg ${p.avgCost}  last ${p.statementPrice}  CLP ${fmt(p.marketValue)}`);
  for (const f of s.funds) console.log(`  ${f.code.padEnd(11)} ${f.name ?? ""}  CLP ${fmt(f.value)}`);
  console.log(`  cash CLP ${fmt(s.cash)} · pending settlement CLP ${fmt(s.pendingSettlement)}` +
    (s.fundYield != null ? ` · fund yield ${(100 * s.fundYield).toFixed(2)}%/yr` : ""));
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: holdings.ts <statement.pdf> | --latest");
  process.exit(2);
}

if (arg === "--latest") {
  const files = existsSync(CL_HOLDINGS) ? readdirSync(CL_HOLDINGS).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
  if (!files.length) {
    console.error("No statement has been read yet.");
    process.exit(1);
  }
  show(JSON.parse(readFileSync(join(CL_HOLDINGS, files.at(-1)!), "utf8")));
  process.exit(0);
}

const stored = existsSync(CL_HOLDINGS) ? readdirSync(CL_HOLDINGS).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
const statement = parseStatement(statementText(arg));
if (process.argv.includes("--if-newer") && stored.length && statement.asOf < stored.at(-1)!.slice(0, 10)) {
  console.log(`${basename(arg)} is the statement of ${statement.asOf}, older than the stored ${stored.at(-1)!.slice(0, 10)}: left in place.`);
  process.exit(3);
}
const problems = checkStatement(statement);
show(statement);
if (problems.length) {
  console.error("\nThe parse does not add up:\n- " + problems.join("\n- "));
  process.exit(1);
}

mkdirSync(CL_HOLDINGS, { recursive: true });
mkdirSync(CL_STATEMENTS, { recursive: true });
const out = join(CL_HOLDINGS, `${statement.asOf}.json`);
writeFileSync(out, JSON.stringify({ ...statement, source: basename(arg), readAt: new Date().toISOString() }, null, 1));

const filed = join(CL_STATEMENTS, `${statement.asOf}-${basename(arg)}`);
if (!arg.startsWith(CL_STATEMENTS)) {
  try {
    renameSync(arg, filed);
  } catch {
    copyFileSync(arg, filed);
    unlinkSync(arg);
  }
}
console.log(`\nWritten ${out}\nStatement filed at ${arg.startsWith(CL_STATEMENTS) ? arg : filed}`);

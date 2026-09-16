/**
 * Side-effect module: pin the process CWD to the repo root.
 *
 * lib/whatsapp/db.ts resolves the SQLite file from process.cwd(), and wiki.ts
 * does the same for wiki/. An MCP server is launched by a client (Claude Code,
 * a tunnel, launchd) whose working directory we don't control, so this must run
 * BEFORE anything that touches those paths — import it first in every
 * entrypoint, on its own line, so ESM evaluates it ahead of the rest.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

export { repoRoot };

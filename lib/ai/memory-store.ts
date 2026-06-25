import fs from "fs";
import path from "path";

const MEMORY_DIR = "/tmp/memories";

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function resolveMemoryPath(inputPath: string): string {
  // Map /memories/... → MEMORY_DIR/...
  const stripped = inputPath.replace(/^\/memories\/?/, "");
  const resolved = path.resolve(path.join(MEMORY_DIR, stripped));
  if (!resolved.startsWith(path.resolve(MEMORY_DIR))) {
    throw new Error(`Path traversal blocked: ${inputPath}`);
  }
  return resolved;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function listDirContents(absPath: string, displayPath: string, depth = 0): string {
  const entries = fs.readdirSync(absPath);
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = path.join(absPath, entry);
    const display = `${displayPath}/${entry}`;
    const stat = fs.statSync(full);
    lines.push(`${humanSize(stat.size)}\t${display}`);
    if (stat.isDirectory() && depth < 1) {
      lines.push(...listDirContents(full, display, depth + 1).split("\n").filter(Boolean));
    }
  }
  return lines.join("\n");
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Reads every stored memory file directly (no model call) and returns their
 * concatenated contents with per-file headers, capped at `maxBytes`. Returns ""
 * when nothing is stored. Lets the synthesis call read raw notes itself instead
 * of paying for a separate agentic summarization pass.
 */
export function readAllMemories(maxBytes = 8000): string {
  ensureDir(MEMORY_DIR);
  let files: string[];
  try {
    files = walkFiles(MEMORY_DIR).sort();
  } catch {
    return "";
  }
  const parts: string[] = [];
  let total = 0;
  for (const f of files) {
    let content: string;
    try { content = fs.readFileSync(f, "utf-8").trim(); } catch { continue; }
    if (!content) continue;
    const rel = f.replace(path.resolve(MEMORY_DIR), "/memories");
    const block = `### ${rel}\n${content}\n`;
    if (total + block.length > maxBytes) break;
    parts.push(block);
    total += block.length;
  }
  return parts.join("\n");
}

export function handleMemoryCommand(input: Record<string, unknown>): string {
  ensureDir(MEMORY_DIR);

  try {
    const command = input.command as string;

    if (command === "view") {
      const inputPath = (input.path as string) || "/memories";
      const abs = resolveMemoryPath(inputPath);
      if (!fs.existsSync(abs)) {
        return `The path ${inputPath} does not exist. Please provide a valid path.`;
      }
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        const inner = listDirContents(abs, inputPath);
        const header = `Here're the files and directories up to 2 levels deep in ${inputPath}, excluding hidden items and node_modules:`;
        const selfLine = `${humanSize(stat.size)}\t${inputPath}`;
        return `${header}\n${selfLine}${inner ? "\n" + inner : ""}`;
      }
      // File view
      const content = fs.readFileSync(abs, "utf-8");
      const lines = content.split("\n");
      const [start, end] = (input.view_range as [number, number] | undefined) ?? [1, lines.length];
      const slice = lines.slice(start - 1, end);
      const numbered = slice
        .map((l, i) => `${String(start + i).padStart(6)}\t${l}`)
        .join("\n");
      return `Here's the content of ${inputPath} with line numbers:\n${numbered}`;
    }

    if (command === "create") {
      const inputPath = input.path as string;
      const abs = resolveMemoryPath(inputPath);
      if (fs.existsSync(abs)) return `Error: File ${inputPath} already exists`;
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, (input.file_text as string) ?? "", "utf-8");
      return `File created successfully at: ${inputPath}`;
    }

    if (command === "str_replace") {
      const inputPath = input.path as string;
      const abs = resolveMemoryPath(inputPath);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        return `Error: The path ${inputPath} does not exist. Please provide a valid path.`;
      }
      const content = fs.readFileSync(abs, "utf-8");
      const oldStr = input.old_str as string;
      // Find all occurrences and their line numbers
      const lines = content.split("\n");
      const matchLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (content.indexOf(oldStr) !== -1) {
          // track line-level occurrences
          if (lines[i].includes(oldStr)) matchLines.push(i + 1);
        }
      }
      const count = (content.match(new RegExp(oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
      if (count === 0) {
        return `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${inputPath}.`;
      }
      if (count > 1) {
        return `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${matchLines.join(", ")}. Please ensure it is unique`;
      }
      const newContent = content.replace(oldStr, (input.new_str as string) ?? "");
      fs.writeFileSync(abs, newContent, "utf-8");
      const snippet = newContent.split("\n").slice(0, 10).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n");
      return `The memory file has been edited.\n${snippet}`;
    }

    if (command === "insert") {
      const inputPath = input.path as string;
      const abs = resolveMemoryPath(inputPath);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        return `Error: The path ${inputPath} does not exist`;
      }
      const lines = fs.readFileSync(abs, "utf-8").split("\n");
      const insertLine = (input.insert_line as number) ?? 0;
      if (insertLine < 0 || insertLine > lines.length) {
        return `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`;
      }
      const toInsert = ((input.insert_text as string) ?? "").split("\n");
      lines.splice(insertLine, 0, ...toInsert);
      fs.writeFileSync(abs, lines.join("\n"), "utf-8");
      return `The file ${inputPath} has been edited.`;
    }

    if (command === "delete") {
      const inputPath = input.path as string;
      const abs = resolveMemoryPath(inputPath);
      if (!fs.existsSync(abs)) return `Error: The path ${inputPath} does not exist`;
      fs.rmSync(abs, { recursive: true, force: true });
      return `Successfully deleted ${inputPath}`;
    }

    if (command === "rename") {
      const oldInput = input.old_path as string;
      const newInput = input.new_path as string;
      const oldAbs = resolveMemoryPath(oldInput);
      const newAbs = resolveMemoryPath(newInput);
      if (!fs.existsSync(oldAbs)) return `Error: The path ${oldInput} does not exist`;
      if (fs.existsSync(newAbs)) return `Error: The destination ${newInput} already exists`;
      ensureDir(path.dirname(newAbs));
      fs.renameSync(oldAbs, newAbs);
      return `Successfully renamed ${oldInput} to ${newInput}`;
    }

    return `Error: Unknown command: ${command}`;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Path traversal")) {
      return `Error: ${err.message}`;
    }
    throw err;
  }
}

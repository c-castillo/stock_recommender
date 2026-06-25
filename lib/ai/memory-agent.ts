/**
 * Runs agentic memory loops using AI SDK ToolLoopAgent + @ai-sdk/anthropic.
 * Claude reads and writes /tmp/memories/ before and after each analysis session.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import { handleMemoryCommand, readAllMemories } from "./memory-store";

const memoryTool = tool({
  description:
    "File-based memory tool. Commands: view (list dir or read file), create (new file), " +
    "str_replace (replace text in file), insert (insert lines), delete (file or dir), rename (move). " +
    "All paths must start with /memories/.",
  inputSchema: z.object({
    command: z.enum(["view", "create", "str_replace", "insert", "delete", "rename"]),
    path: z.string().optional().describe("File or directory path"),
    old_path: z.string().optional().describe("Source path for rename"),
    new_path: z.string().optional().describe("Destination path for rename"),
    file_text: z.string().optional().describe("Content for create"),
    old_str: z.string().optional().describe("Exact text to replace"),
    new_str: z.string().optional().describe("Replacement text"),
    insert_line: z.number().optional().describe("Line number to insert after (0 = start)"),
    insert_text: z.string().optional().describe("Text to insert"),
    view_range: z.tuple([z.number(), z.number()]).optional().describe("[startLine, endLine]"),
  }),
  execute: async (input) => handleMemoryCommand(input as Record<string, unknown>),
});

const MEMORY_SYSTEM = `You have a file-based memory directory at /memories/.
ALWAYS start by viewing /memories/ to check for prior notes.
Keep memory files concise and well-organized. Prefer updating existing files over creating new ones.`;

const memoryAgent = new ToolLoopAgent({
  model: anthropic("claude-haiku-4-5-20251001"),
  instructions: MEMORY_SYSTEM,
  tools: { memory: memoryTool },
  // Bounded ceiling: a normal update is view-dir → maybe view a file →
  // str_replace/create → done. 5 keeps a runaway loop from racking up calls
  // without truncating a legitimate multi-step write.
  stopWhen: stepCountIs(5),
  maxOutputTokens: 2048,
});

/**
 * Returns prior-session memory for injection into the synthesis prompt.
 *
 * Reads the stored notes directly from disk — no model call. The flagship
 * synthesis call reads the raw notes itself, so the old agentic summarization
 * pass (up to 10 Claude round-trips) was redundant.
 */
export async function preAnalysisMemoryCheck(): Promise<string> {
  const notes = readAllMemories();
  if (!notes.trim()) return "";
  return `\n## Memory from prior sessions\n${notes}\n`;
}

/**
 * Updates memory after analysis with key insights from the current session.
 */
export async function postAnalysisMemoryUpdate(
  analysisJson: string,
  date: string
): Promise<void> {
  try {
    await memoryAgent.generate({
      prompt:
        `Today is ${date}. Update your memory with key takeaways from this analysis session. ` +
        `Focus on: high-confidence BUY/SELL calls, notable market observations, and anything worth remembering for future sessions. ` +
        `Do not duplicate what is already stored. Keep files concise.\n\nAnalysis JSON:\n${analysisJson}`,
    });
  } catch {
    // Non-fatal: memory update failure should not break the response
  }
}

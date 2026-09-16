/**
 * Local entrypoint: MCP over stdio, for Claude Code on this machine.
 *
 * No token and no network — the client owns the process. Registered in
 * .mcp.json. For phone access use ./http.ts instead.
 */

import "./chdir-root.mjs";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./server.mjs";

const server = buildMcpServer();
await server.connect(new StdioServerTransport());

/**
 * Remote entrypoint: MCP over Streamable HTTP, for the Claude mobile app.
 *
 * Binds to loopback only and is meant to be published through a tunnel
 * (`pnpm mcp:tunnel`). Two things guard it:
 *
 *   1. MCP_TOKEN — required. Presented either as `Authorization: Bearer <token>`
 *      or as a path segment (`/mcp/<token>`). The path form exists because
 *      Claude's custom-connector UI takes a URL but not an arbitrary header;
 *      a URL with a 32-byte secret in it is the practical way to authenticate
 *      a personal connector without standing up OAuth. Treat that URL as the
 *      credential it is.
 *   2. Loopback binding — only the tunnel process can reach the port, so a
 *      stopped tunnel closes the door completely.
 *
 * Each request gets a fresh server + stateless transport: no session state to
 * leak between calls, and a dropped mobile connection costs nothing.
 */

import "./chdir-root.mjs";

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./server.mjs";

const PORT = Number(process.env.MCP_PORT ?? 3399);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";
const TOKEN = process.env.MCP_TOKEN;

if (!TOKEN || TOKEN.length < 16) {
  console.error(
    "MCP_TOKEN is missing or too short (need ≥16 chars).\n" +
      "Generate one and put it in .env.local:\n\n" +
      "  echo \"MCP_TOKEN=$(openssl rand -hex 32)\" >> .env.local\n"
  );
  process.exit(1);
}

function tokenMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(TOKEN!);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bearer header or `/mcp/<token>` path segment. Returns the matched route. */
function authorize(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ") && tokenMatches(header.slice(7).trim())) return true;

  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const segments = pathname.split("/").filter(Boolean);
  return segments[0] === "mcp" && segments.length === 2 && tokenMatches(segments[1]);
}

function isMcpPath(req: http.IncomingMessage): boolean {
  const segments = new URL(req.url ?? "/", "http://localhost").pathname
    .split("/")
    .filter(Boolean);
  return segments[0] === "mcp" && segments.length <= 2;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Unauthenticated liveness probe — says nothing about the corpus.
  if (req.url === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isMcpPath(req)) {
    sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
    return;
  }

  if (!authorize(req)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer", ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // The transport routes on method/body, not path — normalise so the token
  // segment never reaches it.
  req.url = "/mcp";

  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("[mcp] request failed:", err);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(
    `[mcp] stock-recommender listening on http://${HOST}:${PORT}/mcp\n` +
      `[mcp] connector URL (token in path): http://${HOST}:${PORT}/mcp/${TOKEN}\n` +
      `[mcp] expose it with:  pnpm mcp:tunnel`
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => httpServer.close(() => process.exit(0)));
}

import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRockyMcpServer, type RockyMcpDeps } from "./server.ts";

export { createRockyMcpServer, type RockyMcpDeps } from "./server.ts";

/**
 * `rocky mcp`: serves the read-only tools over this process's stdin/stdout. Both protocol eras
 * (2026-07-28 and 2025 clients) are served from the same factory. Logs must go to stderr.
 */
export function serveRockyStdio(deps: RockyMcpDeps): StdioServerHandle {
  return serveStdio(() => createRockyMcpServer(deps), {
    onerror: (err) => process.stderr.write(`mcp: ${err.message}\n`),
  });
}

/**
 * Streamable HTTP handler for the daemon's /api/v1/mcp route. Stateless: one server per request.
 * The daemon's auth middleware (bearer token, Host and Origin checks) runs before it.
 */
export function createRockyMcpHttpHandler(deps: RockyMcpDeps): McpHttpHandler {
  return createMcpHandler(() => createRockyMcpServer(deps));
}

import { keychainSecrets, loadAppConfig, openRuntime, resolveDataDir } from "@rocky/core";

/**
 * `rocky mcp`: Rocky's read-only tools over stdio for an MCP client such as Claude Code
 * (`claude mcp add rocky -- rocky mcp`). stdout carries the protocol, so every log goes to stderr.
 */
export async function mcpCommand(opts: {
  dataDir?: string | undefined;
  http?: boolean;
  showToken?: boolean;
}): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  if (opts.http) return printHttp(dir, Boolean(opts.showToken));

  // Anything printed to stdout would corrupt the JSON-RPC stream.
  console.log = console.error;
  console.info = console.error;
  const rt = await openRuntime({ dataDir: dir });
  const { serveRockyStdio } = await import("@rocky/mcp");
  const handle = serveRockyStdio({
    db: rt.db,
    embedder: rt.embedder,
    // Re-read per call: a localOnly switch made in the daemon applies here too.
    config: () => {
      try {
        return loadAppConfig(dir);
      } catch {
        return rt.config;
      }
    },
  });
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await handle.close().catch(() => {});
  rt.close();
  return 0;
}

async function printHttp(dir: string, showToken: boolean): Promise<number> {
  const { daemonInfoFile } = await import("@rocky/daemon");
  const fs = await import("node:fs");
  const file = daemonInfoFile(dir);
  const port = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as { port: number }).port
    : loadAppConfig(dir).daemon.port;
  const url = `http://127.0.0.1:${port}/api/v1/mcp`;
  console.log(`Streamable HTTP endpoint (needs the running daemon): ${url}`);
  console.log("Requests need the header: Authorization: Bearer <install token>");
  if (showToken) {
    const token = keychainSecrets().get("daemon-token");
    if (!token) {
      console.error("No install token yet. Start the daemon once with `rocky daemon`.");
      return 1;
    }
    console.log(`Install token: ${token}`);
    console.log("Anyone with this token can read your memory through the daemon. Keep it private.");
  } else {
    console.log(
      "Prefer stdio, which needs no token: claude mcp add rocky -- rocky mcp\n" +
        "To print the token for an HTTP client, add --show-token.",
    );
  }
  return 0;
}

import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  JobRunner,
  type OpenRuntimeOptions,
  openRuntime,
  type Runtime,
  redactingLogger,
} from "@rocky/core";
import { createApp } from "./app.ts";
import { Auth, newToken } from "./auth.ts";

export { createApp } from "./app.ts";
export { Auth, newToken } from "./auth.ts";

/** Built UI from apps/web (Phase 1 web shell); absent until `pnpm --filter @rocky/web build`. */
const defaultWebDir = fileURLToPath(new URL("../../web/dist/", import.meta.url));

/** `<dataDir>/daemon.json` tells the CLI where the running daemon listens. */
export const daemonInfoFile = (dataDir: string) => path.join(dataDir, "daemon.json");

/** The install token lives in the keychain (SECURITY.md); created on first run. */
export function installToken(rt: Runtime): string {
  const existing = rt.secrets.get("daemon-token");
  if (existing) return existing;
  const token = newToken();
  rt.secrets.set("daemon-token", token);
  return token;
}

export interface RunningDaemon {
  /** The address actually bound (always 127.0.0.1). */
  host: string;
  port: number;
  url: string;
  stop(): Promise<void>;
}

export async function startDaemon(opts: {
  dataDir: string;
  port?: number;
  webDir?: string;
  log?: (msg: string) => void;
  /** Test seams (secrets, fetch, hardware). */
  runtime?: Omit<OpenRuntimeOptions, "dataDir">;
}): Promise<RunningDaemon> {
  const log = redactingLogger(opts.log ?? ((m) => console.error(m)));
  const rt = await openRuntime({ ...opts.runtime, dataDir: opts.dataDir });
  const port = opts.port ?? rt.config.daemon.port;
  const auth = new Auth({ token: installToken(rt), port });
  const runner = new JobRunner(rt.db, rt.jobHandlers, { log });
  runner.start();

  const webDir = opts.webDir ?? defaultWebDir;
  const app = createApp({
    rt,
    auth,
    poke: () => runner.poke(),
    ...(fs.existsSync(path.join(webDir, "index.html")) ? { webDir } : {}),
  });
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  fs.writeFileSync(daemonInfoFile(opts.dataDir), JSON.stringify({ port, pid: process.pid }));
  const url = `http://127.0.0.1:${port}`;
  log(`rocky daemon listening on ${url} (data: ${opts.dataDir})`);

  return {
    host: (server.address() as AddressInfo).address,
    port,
    url,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runner.stop();
      fs.rmSync(daemonInfoFile(opts.dataDir), { force: true });
      rt.close();
    },
  };
}

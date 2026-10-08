import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  ConnectorScheduler,
  deleteEverything,
  FolderWatcher,
  JobRunner,
  type OpenRuntimeOptions,
  openRuntime,
  type Runtime,
  redactingLogger,
} from "@rocky/core";
import { createApp } from "./app.ts";
import { Auth, newToken } from "./auth.ts";
import { CONNECTOR_HOST_ENTRY, registerConnectors } from "./connectors.ts";

export { createApp } from "./app.ts";
export { Auth, newToken } from "./auth.ts";
export { CONNECTOR_HOST_ENTRY, registerConnectors } from "./connectors.ts";
export { deleteArchiveImport, importArchive, listArchiveImports } from "./imports.ts";

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
  /** Runs once the runtime is open, e.g. to register action definitions (tests, dev smoke). */
  setup?: (rt: Runtime) => void;
}): Promise<RunningDaemon> {
  const log = redactingLogger(opts.log ?? ((m) => console.error(m)));
  // Connector code and its tokens live in a separate process (roadmap I1); test seams that pass
  // their own secrets run connectors in-process instead.
  const connectors =
    opts.runtime?.connectors ??
    (opts.runtime?.secrets
      ? ({ kind: "in-process" } as const)
      : ({ kind: "process", entry: CONNECTOR_HOST_ENTRY } as const));
  const rt = await openRuntime({ ...opts.runtime, connectors, dataDir: opts.dataDir });
  opts.setup?.(rt);
  await registerConnectors(rt, log);
  const port = opts.port ?? rt.config.daemon.port;
  const auth = new Auth({ token: installToken(rt), port });
  const runner = new JobRunner(rt.db, rt.jobHandlers, { log });
  runner.start();
  const watcher = new FolderWatcher({
    db: rt.db,
    blobsDir: rt.paths.blobs,
    onIngested: () => runner.poke(),
    log,
  });
  // The initial scan can take a while on big folders; the API comes up without waiting for it.
  void watcher.start().catch((e: unknown) => log(`watch start failed: ${String(e)}`));
  // Connector syncs run on their own lane; one tick now (catch-up after downtime), then every minute.
  const scheduler = new ConnectorScheduler(rt.connectors);
  scheduler.start();
  // Notebook rules also pick up documents from imports and watched folders (notebooks.md).
  const notebookTimer = setInterval(() => rt.refreshNotebooks(), 10 * 60_000);
  notebookTimer.unref();
  // Routines: catch up once now (a run missed while asleep), then check every minute.
  const tickRoutines = () => {
    try {
      if (rt.tickRoutines().length) runner.poke();
    } catch (err) {
      log(`routine tick failed: ${String(err)}`);
    }
  };
  tickRoutines();
  const routineTimer = setInterval(tickRoutines, 60_000);
  routineTimer.unref();

  const webDir = opts.webDir ?? defaultWebDir;
  const app = createApp({
    rt,
    auth,
    poke: () => runner.poke(),
    rewatch: () => watcher.start(),
    deleteEverything: async () => {
      log("deleting everything at the user's request");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearInterval(notebookTimer);
      clearInterval(routineTimer);
      await scheduler.stop();
      await watcher.stop();
      await runner.stop();
      rt.close();
      const { removed } = deleteEverything(opts.dataDir, rt.secrets);
      log(`removed ${removed.length} items; the daemon is exiting`);
      process.exit(0);
    },
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
      clearInterval(notebookTimer);
      clearInterval(routineTimer);
      await scheduler.stop();
      await watcher.stop();
      await runner.stop();
      fs.rmSync(daemonInfoFile(opts.dataDir), { force: true });
      rt.close();
    },
  };
}

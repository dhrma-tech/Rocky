import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  ActionScheduler,
  APPROVAL_HOLD_MS,
  type ChannelHost,
  ChannelHostClient,
  ConnectorScheduler,
  channelOnlySecrets,
  dailyBackup,
  deleteEverything,
  FolderWatcher,
  forkChannelHost,
  home,
  InProcessChannelHost,
  JobRunner,
  listRuns,
  Notifier,
  type OpenRuntimeOptions,
  openRuntime,
  PhoneDispatcher,
  type Runtime,
  redactingLogger,
  runHeadsUps,
  shippedDir,
  TelegramBot,
  unreadCount,
  verifyDeviceToken,
} from "@rocky/core";
import { createApp } from "./app.ts";
import { runAsk } from "./ask-run.ts";
import { Auth, newToken } from "./auth.ts";
import { CONNECTOR_HOST_ENTRY, registerConnectors } from "./connectors.ts";

/** The channel host process entry (channel-host.ts): phone channel secrets live only there. */
export const CHANNEL_HOST_ENTRY = fileURLToPath(new URL("./channel-host.ts", import.meta.url));

export { createApp } from "./app.ts";
export { Auth, newToken } from "./auth.ts";
export { CONNECTOR_HOST_ENTRY, registerConnectors } from "./connectors.ts";
export { deleteArchiveImport, importArchive, listArchiveImports } from "./imports.ts";

/** Built UI from apps/web (Phase 1 web shell); absent until `pnpm --filter @rocky/web build`. */
const defaultWebDir = shippedDir("web");

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
  const auth = new Auth({
    token: installToken(rt),
    port,
    allowedHosts: () => rt.config.daemon.allowedHosts,
    devices: { verify: (token) => verifyDeviceToken(rt.db, token) !== null },
  });
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
  // Approved actions run once their 10 s Undo window passes (docs/DECISIONS.md D-014).
  const actionScheduler = new ActionScheduler(rt.actions, { log });
  actionScheduler.start();
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
  // Daily backup (roadmap I3): checked at start and hourly, so a day missed in sleep is made on wake.
  const backup = () => {
    try {
      dailyBackup(rt.db, rt.paths.backups);
    } catch (err) {
      log(`daily backup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  backup();
  const backupTimer = setInterval(backup, 60 * 60_000);
  backupTimer.unref();
  // Phone channels (D-065) run in their own process, started on first use; test seams that pass
  // their own secrets run them in-process.
  const testSecrets = opts.runtime?.secrets;
  const channels: ChannelHost = testSecrets
    ? new InProcessChannelHost({
        secrets: channelOnlySecrets(testSecrets),
        fetch: opts.runtime?.fetch ?? globalThis.fetch,
        config: () => rt.config,
      })
    : forkChannelHost(CHANNEL_HOST_ENTRY, ["--data-dir", opts.dataDir], log);
  const phone = new PhoneDispatcher({ db: rt.db, host: channels, config: () => rt.config, log });
  // Telegram (D-066): the channel host polls; messages from allowed users come here.
  const bot = new TelegramBot({
    send: (m) => channels.sendTelegram(m),
    answerCallback: (id, text) => channels.answerCallback(id, text),
    settings: () => ({
      approveLowRiskInChat: rt.config.notifications.telegram.approveLowRiskInChat,
      phoneHost: rt.config.daemon.allowedHosts[0],
    }),
    drafts: () => rt.actions.list("draft"),
    approve: (id, hash) =>
      rt.actions.approve(id, hash, { holdMs: APPROVAL_HOLD_MS, via: "telegram" }),
    ask: (question) => runAsk(rt, { question }, undefined, { via: "Telegram" }),
    status: () => ({
      running: listRuns(rt.db, { status: "active" }).length,
      approvals: rt.actions.list("draft").length,
      unread: unreadCount(rt.db),
    }),
    today: () => {
      const h = home(rt.db);
      return { events: h.today.length, dueSoon: h.dueSoon.length, overdue: h.overdue.length };
    },
    log,
  });
  if (channels instanceof ChannelHostClient)
    channels.onInbound((m) => {
      const tg = rt.config.notifications.telegram;
      // Checked again here: the host filters, but the daemon decides.
      if (m.kind === "stranger" || rt.config.localOnly || !tg.enabled) return;
      if (!tg.userIds.includes(m.fromId)) return;
      void bot.handle(m);
    });
  // The host polls only while it runs; with Telegram on, keep it running (and restart it after a
  // crash) by asking for its status every minute.
  const keepTelegram = () => {
    const tg = rt.config.notifications.telegram;
    if (tg.enabled && !rt.config.localOnly)
      void channels.status().catch((e: unknown) => log(`channel host: ${String(e)}`));
  };
  keepTelegram();
  const telegramTimer = setInterval(keepTelegram, 60_000);
  telegramTimer.unref();
  // Notifications (UI spec 16): follow the event log each second; in-app keeps the record, and
  // the phone gets what the preferences allow.
  const notifier = new Notifier({ db: rt.db, onNew: (n) => void phone.dispatch(n) });
  const notify = () => {
    try {
      notifier.tick();
    } catch (err) {
      log(`notifier tick failed: ${String(err)}`);
    }
  };
  notify();
  const notifyTimer = setInterval(notify, 1000);
  notifyTimer.unref();
  // Heads-ups (roadmap A7, D-067): checked at start and every 10 minutes; runs once a day from
  // 08:00. Filed straight into notifications, so the phone gets them as it gets the rest.
  const headsUp = () => {
    try {
      const perDay = rt.config.notifications.headsUp.perDay;
      for (const n of runHeadsUps(rt.db, { perDay })) void phone.dispatch(n);
    } catch (err) {
      log(`heads-up run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  headsUp();
  const headsUpTimer = setInterval(headsUp, 10 * 60_000);
  headsUpTimer.unref();

  const webDir = opts.webDir ?? defaultWebDir;
  const app = createApp({
    rt,
    auth,
    poke: () => runner.poke(),
    rewatch: () => watcher.start(),
    channels,
    deleteEverything: async () => {
      log("deleting everything at the user's request");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearInterval(notebookTimer);
      clearInterval(routineTimer);
      clearInterval(backupTimer);
      clearInterval(notifyTimer);
      clearInterval(telegramTimer);
      clearInterval(headsUpTimer);
      await scheduler.stop();
      await actionScheduler.stop();
      await watcher.stop();
      await runner.stop();
      await channels.close();
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
      clearInterval(backupTimer);
      clearInterval(notifyTimer);
      clearInterval(telegramTimer);
      clearInterval(headsUpTimer);
      await scheduler.stop();
      await actionScheduler.stop();
      await watcher.stop();
      await runner.stop();
      await channels.close();
      fs.rmSync(daemonInfoFile(opts.dataDir), { force: true });
      rt.close();
    },
  };
}

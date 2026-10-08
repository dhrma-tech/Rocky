import type { AppConfig, Hardware } from "@rocky/contracts";
import { ActionRegistry } from "./actions/registry.ts";
import { ActionService } from "./actions/service.ts";
import {
  queueDueRoutines,
  ROUTINE_JOB,
  routineJobHandler,
  seedRoutines,
} from "./assistant/routines.ts";
import { queueStyleRefresh, STYLE_JOB, styleJobHandler } from "./assistant/style.ts";
import { resolveFfmpeg } from "./capture/ffmpeg.ts";
import { TRANSCRIBE_JOB } from "./capture/recordings.ts";
import { transcribeMeeting, UNDERSTAND_JOB } from "./capture/transcribe-job.ts";
import { loadAppConfig } from "./config/load.ts";
import { type DataPaths, dataPaths } from "./config/paths.ts";
import {
  type ConnectorHost,
  InProcessConnectorHost,
  UnavailableConnectorHost,
} from "./connectors/host.ts";
import { forkConnectorHost } from "./connectors/host-ipc.ts";
import { ConnectorRegistry, ConnectorService } from "./connectors/service.ts";
import { EMBED_JOB, embedDocument } from "./ingest/embed-job.ts";
import { type JobHandler, JobRunner } from "./jobs/runner.ts";
import { STUDY_JOB, studyJobHandler } from "./notebooks/jobs.ts";
import { materializeAll } from "./notebooks/scope.ts";
import { type Embedder, ollamaEmbedder } from "./router/embed.ts";
import { ProviderGate } from "./router/gate.ts";
import { loadPolicy } from "./router/policy.ts";
import { loadPrices } from "./router/prices.ts";
import { Router } from "./router/router.ts";
import { coreOnlySecrets, keychainSecrets, type SecretStore } from "./secrets/keychain.ts";
import { type Db, openDb } from "./store/db.ts";
import { encryptNewStore, storeKey } from "./store/encryption.ts";
import { migrate } from "./store/migrate.ts";
import type { ProcessRunner } from "./system/exec.ts";
import { detectHardware } from "./system/hardware.ts";
import { whisperStatus } from "./system/whisper.ts";
import { understandMeeting } from "./understanding/understand-job.ts";

export interface Runtime {
  dataDir: string;
  paths: DataPaths;
  config: AppConfig;
  db: Db;
  gate: ProviderGate;
  router: Router;
  embedder: Embedder;
  hardware: Hardware;
  secrets: SecretStore;
  /** Action definitions; connectors register theirs here (Phase 4). */
  registry: ActionRegistry;
  /** The approval queue; the only path to an executor. */
  actions: ActionService;
  /** Connector definitions (built-ins and plugins, registered by the daemon or CLI). */
  connectorRegistry: ConnectorRegistry;
  connectors: ConnectorService;
  /** Handlers for every job type; the daemon runs them in a JobRunner. */
  jobHandlers: Record<string, JobHandler>;
  /** Queues routines whose scheduled time has come (the daemon calls it every minute). */
  tickRoutines(now?: number): string[];
  /** Re-applies notebook rules soon (debounced): after syncs, ingests, and on a timer in the daemon. */
  refreshNotebooks(): void;
  /** Runs every queued job (embedding) to completion. The daemon runs them in the background instead. */
  drainJobs(log?: (msg: string) => void): Promise<number>;
  close(): void;
}

export interface OpenRuntimeOptions {
  dataDir: string;
  /** DB file; defaults to `<dataDir>/rocky.db`. Evals use their own file. */
  dbFile?: string;
  /** Forces local-only for this runtime on top of the config setting. */
  localOnly?: boolean;
  secrets?: SecretStore;
  /**
   * Where connector code runs (roadmap I1). "process" forks the host entry, which alone holds
   * connector tokens. "in-process" is for tests and needs `secrets`. Default: in-process when
   * `secrets` is given (tests), otherwise none (commands that never touch connectors).
   */
  connectors?: { kind: "process"; entry: string } | { kind: "in-process" } | { kind: "none" };
  fetch?: typeof fetch;
  hardware?: Hardware;
  /** Test seam for whisper-cli and ffmpeg. */
  run?: ProcessRunner;
  /** Test seam: where the tools are, instead of probing the data dir and PATH. */
  tools?: { whisper?: { binary: string; model: string }; ffmpeg?: string | null };
}

/** Wires store, config, router and embedder for one data dir (CLI, evals, daemon). */
export async function openRuntime(opts: OpenRuntimeOptions): Promise<Runtime> {
  const paths = dataPaths(opts.dataDir);
  const loaded = loadAppConfig(opts.dataDir);
  const rawSecrets = opts.secrets ?? keychainSecrets();
  const connectorMode = opts.connectors ?? { kind: opts.secrets ? "in-process" : "none" };
  // Outside tests, this process never reads or writes a connector token.
  const secrets = connectorMode.kind === "in-process" ? rawSecrets : coreOnlySecrets(rawSecrets);
  const dbFile = opts.dbFile ?? paths.db;
  // Encrypted by default for a new main store (roadmap M5). Not for a side file such as an eval
  // DB (the setting is per data dir), and not for test seams that pass their own secrets.
  const config =
    opts.secrets || opts.dbFile
      ? loaded
      : encryptNewStore(opts.dataDir, loaded, rawSecrets, paths.db);
  const db = openDb(dbFile, { key: storeKey(config, secrets, dbFile) });
  migrate(db, { backupDir: paths.backups });

  const hardware = opts.hardware ?? (await detectHardware());
  const policy = loadPolicy(opts.dataDir);
  const prices = loadPrices(opts.dataDir);
  const localOnly = () => config.localOnly || Boolean(opts.localOnly);
  const gate = new ProviderGate(db, {
    settings: () => ({
      localOnly: localOnly(),
      monthlyCapUsd: config.budget.monthlyCapUsd,
      ollamaBaseUrl: config.ollama.baseUrl,
    }),
    prices: () => prices,
    secrets,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const router = new Router({
    gate,
    policy: () => policy,
    hardware: () => hardware,
    globalLocalOnly: localOnly,
  });
  const embedModel = policy.models.embed?.split("/").slice(1).join("/") ?? "nomic-embed-text";
  const embedder = ollamaEmbedder({
    baseUrl: config.ollama.baseUrl,
    model: embedModel,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  seedRoutines(db, { dataDir: opts.dataDir });
  const registry = new ActionRegistry();
  const actions = new ActionService(db, registry);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshNotebooks = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      try {
        materializeAll(db);
      } catch {
        // The DB may be closing; the next refresh catches up.
      }
    }, 2000);
    refreshTimer.unref?.();
  };
  const connectorRegistry = new ConnectorRegistry();
  const connectorHost: ConnectorHost =
    connectorMode.kind === "process"
      ? forkConnectorHost(connectorMode.entry, ["--data-dir", opts.dataDir], (m) =>
          console.error(m),
        )
      : connectorMode.kind === "in-process"
        ? new InProcessConnectorHost({
            registry: connectorRegistry,
            secrets: rawSecrets,
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
          })
        : new UnavailableConnectorHost();
  const connectors = new ConnectorService({
    db,
    host: connectorHost,
    registry: connectorRegistry,
    actions: registry,
    blobsDir: paths.blobs,
    onSynced: refreshNotebooks,
  });
  const jobHandlers: Record<string, JobHandler> = {
    [EMBED_JOB]: async (job) => {
      const { documentId } = job.payload as { documentId: string };
      await embedDocument(db, embedder, documentId);
      refreshNotebooks();
    },
    [TRANSCRIBE_JOB]: (job) =>
      transcribeMeeting(
        {
          db,
          blobsDir: paths.blobs,
          recDir: paths.rec,
          whisper: () => {
            const w = opts.tools?.whisper ?? whisperStatus(opts.dataDir, config.whisper.model);
            return { ...w, threads: config.whisper.threads, language: config.whisper.language };
          },
          ffmpeg: async () =>
            opts.tools && "ffmpeg" in opts.tools
              ? (opts.tools.ffmpeg ?? null)
              : resolveFfmpeg(opts.dataDir),
          ...(opts.run ? { run: opts.run } : {}),
        },
        job,
      ),
    [STUDY_JOB]: studyJobHandler({ db, router, embedder }),
    [ROUTINE_JOB]: routineJobHandler({ db, router, dataDir: opts.dataDir }),
    [STYLE_JOB]: styleJobHandler({ db, router }),
    [UNDERSTAND_JOB]: async (job) => {
      await understandMeeting({ db, router }, job);
    },
  };

  return {
    dataDir: opts.dataDir,
    paths,
    config,
    db,
    gate,
    router,
    embedder,
    hardware,
    secrets,
    registry,
    actions,
    connectorRegistry,
    connectors,
    jobHandlers,
    // Routines run as heavy jobs when the model is local (they compete with whisper for the CPU).
    // The same tick refreshes a style profile the user built once, monthly.
    tickRoutines: (now) => {
      queueStyleRefresh(db, now === undefined ? {} : { now });
      return queueDueRoutines(db, now, router.chain("routine", {})[0]?.local ?? true);
    },
    refreshNotebooks,
    drainJobs: (log) => new JobRunner(db, jobHandlers, log ? { log } : {}).drain(),
    close: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      void connectorHost.close();
      db.close();
    },
  };
}

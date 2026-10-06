import type { AppConfig, Hardware } from "@rocky/contracts";
import { ActionRegistry } from "./actions/registry.ts";
import { ActionService } from "./actions/service.ts";
import { resolveFfmpeg } from "./capture/ffmpeg.ts";
import { TRANSCRIBE_JOB } from "./capture/recordings.ts";
import { transcribeMeeting, UNDERSTAND_JOB } from "./capture/transcribe-job.ts";
import { loadAppConfig } from "./config/load.ts";
import { type DataPaths, dataPaths } from "./config/paths.ts";
import { EMBED_JOB, embedDocument } from "./ingest/embed-job.ts";
import { type JobHandler, JobRunner } from "./jobs/runner.ts";
import { type Embedder, ollamaEmbedder } from "./router/embed.ts";
import { ProviderGate } from "./router/gate.ts";
import { loadPolicy } from "./router/policy.ts";
import { loadPrices } from "./router/prices.ts";
import { Router } from "./router/router.ts";
import { keychainSecrets, type SecretStore } from "./secrets/keychain.ts";
import { type Db, openDb } from "./store/db.ts";
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
  /** Handlers for every job type; the daemon runs them in a JobRunner. */
  jobHandlers: Record<string, JobHandler>;
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
  const config = loadAppConfig(opts.dataDir);
  const db = openDb(opts.dbFile ?? paths.db);
  migrate(db, { backupDir: paths.backups });

  const hardware = opts.hardware ?? (await detectHardware());
  const policy = loadPolicy(opts.dataDir);
  const prices = loadPrices(opts.dataDir);
  const localOnly = () => config.localOnly || Boolean(opts.localOnly);
  const secrets = opts.secrets ?? keychainSecrets();
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

  const registry = new ActionRegistry();
  const actions = new ActionService(db, registry);
  const jobHandlers: Record<string, JobHandler> = {
    [EMBED_JOB]: async (job) => {
      const { documentId } = job.payload as { documentId: string };
      await embedDocument(db, embedder, documentId);
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
    jobHandlers,
    drainJobs: (log) => new JobRunner(db, jobHandlers, log ? { log } : {}).drain(),
    close: () => db.close(),
  };
}

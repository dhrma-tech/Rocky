import fs from "node:fs";
import {
  type AppConfig,
  type DataDirSource,
  type DoctorCheck,
  type DoctorReport,
  DoctorReportSchema,
  type Hardware,
} from "@rocky/contracts";
import { openDb, vecStatus } from "./store/db.ts";
import { freeBytes } from "./system/disk.ts";
import { detectHardware } from "./system/hardware.ts";
import { keychainStatus } from "./system/keychain.ts";
import { hasModel, type OllamaStatus, ollamaStatus } from "./system/ollama.ts";
import { whisperStatus } from "./system/whisper.ts";

const MIN_FREE_GB = 10;
const EMBED_MODEL = "nomic-embed-text";
const GB = 1024 ** 3;

/** Probes are injectable so the report logic is testable without the real machine. */
export interface DoctorProbes {
  hardware: () => Promise<Hardware>;
  freeBytes: (dir: string) => number;
  vec: typeof vecStatus;
  fts5: () => boolean;
  ollama: (baseUrl: string) => Promise<OllamaStatus>;
  whisper: typeof whisperStatus;
  keychain: typeof keychainStatus;
  writable: (dir: string) => boolean;
  nodeVersion: string;
  now: () => number;
}

function fts5Available(): boolean {
  const db = openDb(":memory:", { vec: false });
  try {
    db.exec("create virtual table t using fts5(x)");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function isWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export const realProbes: DoctorProbes = {
  hardware: () => detectHardware(),
  freeBytes,
  vec: vecStatus,
  fts5: fts5Available,
  ollama: (u) => ollamaStatus(u),
  whisper: whisperStatus,
  keychain: keychainStatus,
  writable: isWritable,
  nodeVersion: process.versions.node,
  now: Date.now,
};

export interface DoctorInput {
  dataDir: string;
  dataDirSource: DataDirSource;
  config: AppConfig;
}

/** Adds `hint` only when the check is not passing. */
const hintIf = (cond: boolean, hint: string) => (cond ? { hint } : {});

export async function runDoctor(
  input: DoctorInput,
  probes: DoctorProbes = realProbes,
): Promise<DoctorReport> {
  const { dataDir, config } = input;
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  const [major = 0, minor = 0] = probes.nodeVersion.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 18);
  add({
    id: "node",
    label: "Node.js",
    status: nodeOk ? "pass" : "fail",
    detail: `v${probes.nodeVersion}`,
    ...hintIf(!nodeOk, "Rocky needs Node 22.18+ (native TypeScript support)."),
  });

  const [hw, ollama] = await Promise.all([probes.hardware(), probes.ollama(config.ollama.baseUrl)]);
  add({
    id: "os",
    label: "OS",
    status: "pass",
    detail: `${hw.platform} ${hw.release}, ${hw.cpu} (${hw.cores} threads)`,
  });
  add({
    id: "ram",
    label: "RAM",
    status: hw.ramTier === "low" ? "warn" : "pass",
    detail: `${hw.ramGb} GB (tier: ${hw.ramTier})`,
    ...hintIf(hw.ramTier === "low", "Below 12 GB, LLM tasks default to API models."),
  });
  add({
    id: "gpu",
    label: "GPU",
    status: "pass",
    detail: `${hw.gpus.length ? hw.gpus.join(", ") : "none detected"}; CUDA: ${hw.cuda ? "yes" : "no"}`,
  });

  const writable = probes.writable(dataDir);
  add({
    id: "data-dir",
    label: "Data dir",
    status: writable ? "pass" : "fail",
    detail: `${dataDir} (from ${input.dataDirSource})`,
    ...hintIf(!writable, "Set ROCKY_DATA_DIR or pass --data-dir to a writable folder."),
  });

  const freeGb = Math.round((probes.freeBytes(dataDir) / GB) * 10) / 10;
  const lowDisk = freeGb < MIN_FREE_GB;
  add({
    id: "disk",
    label: "Free disk (data drive)",
    status: lowDisk ? "warn" : "pass",
    detail: `${freeGb} GB free`,
    ...hintIf(lowDisk, `Keep at least ${MIN_FREE_GB} GB free for models and recordings.`),
  });

  const vec = probes.vec();
  add({
    id: "sqlite-vec",
    label: "sqlite-vec",
    status: vec.ok ? "pass" : "fail",
    detail: vec.ok ? vec.version : vec.error,
  });
  const fts = probes.fts5();
  add({
    id: "fts5",
    label: "SQLite FTS5",
    status: fts ? "pass" : "fail",
    detail: fts ? "available" : "missing",
  });

  add({
    id: "ollama",
    label: "Ollama",
    status: ollama.ok ? "pass" : "warn",
    detail: ollama.ok
      ? `v${ollama.version} at ${config.ollama.baseUrl}, ${ollama.models.length} models`
      : ollama.error,
    ...hintIf(!ollama.ok, "Start Ollama, or use API models only (local-only mode will not work)."),
  });
  const models = ollama.ok ? ollama.models : [];
  if (ollama.ok) {
    const embed = hasModel(models, EMBED_MODEL);
    add({
      id: "embed-model",
      label: "Embedding model",
      status: embed ? "pass" : "fail",
      detail: embed ? EMBED_MODEL : `${EMBED_MODEL} not pulled`,
      ...hintIf(!embed, `ollama pull ${EMBED_MODEL}`),
    });
  }

  const w = probes.whisper(dataDir, config.whisper.model);
  const whisperOk = Boolean(w.binary && w.model);
  add({
    id: "whisper",
    label: "whisper-cli",
    status: whisperOk ? "pass" : "warn",
    detail: `binary: ${w.binary ?? "missing"}; model ggml-${config.whisper.model}: ${w.model ? "present" : "missing"}`,
    ...hintIf(!whisperOk, "Run `rocky doctor --fix` to download the pinned build and model."),
  });

  const kc = probes.keychain();
  add({
    id: "keychain",
    label: "OS keychain",
    status: kc.ok ? "pass" : "fail",
    detail: kc.ok ? "read/write ok" : kc.error,
  });

  return DoctorReportSchema.parse({
    generatedAt: probes.now(),
    dataDir,
    dataDirSource: input.dataDirSource,
    hardware: hw,
    ollamaModels: models,
    checks,
    ok: checks.every((c) => c.status !== "fail"),
  });
}

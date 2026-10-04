import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AppConfig,
  AppConfigSchema,
  type DataDirSource,
  LocationFileSchema,
} from "@rocky/contracts";
import YAML from "yaml";
import { appDataRoot, dataPaths } from "./paths.ts";

export interface ResolveDataDirInput {
  flag?: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Resolution order: --data-dir flag > ROCKY_DATA_DIR > location.yaml > default. */
export function resolveDataDir(input: ResolveDataDirInput = {}): {
  dir: string;
  source: DataDirSource;
} {
  const env = input.env ?? process.env;
  if (input.flag) return { dir: path.resolve(input.flag), source: "flag" };
  if (env.ROCKY_DATA_DIR) return { dir: path.resolve(env.ROCKY_DATA_DIR), source: "env" };
  const defaultDir = path.join(appDataRoot(input.platform, env), "Rocky");
  const locationFile = path.join(defaultDir, "location.yaml");
  if (fs.existsSync(locationFile)) {
    const parsed = LocationFileSchema.parse(YAML.parse(fs.readFileSync(locationFile, "utf8")));
    return { dir: path.resolve(parsed.dataDir), source: "location-file" };
  }
  return { dir: defaultDir, source: "default" };
}

/** Loads `<dataDir>/rocky.yaml`; a missing file yields all defaults. */
export function loadAppConfig(dataDir: string): AppConfig {
  const file = dataPaths(dataDir).config;
  const raw = fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) : {};
  return AppConfigSchema.parse(raw);
}

/** Repo-level `config/` directory (model IDs and prices live here, never in code). */
export const repoConfigDir = fileURLToPath(new URL("../../../../config/", import.meta.url));

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge: objects merge key by key, everything else (arrays included) is replaced. */
export function deepMerge(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = out[k];
    out[k] = isPlain(b) && isPlain(v) ? deepMerge(b, v) : v;
  }
  return out;
}

/** Loads `config/<name>.yaml` and merges the user's `<dataDir>/config/<name>.yaml` over it. */
export function loadLayeredYaml(name: string, dataDir: string, baseDir = repoConfigDir): Plain {
  const read = (f: string): Plain => {
    if (!fs.existsSync(f)) return {};
    const v = YAML.parse(fs.readFileSync(f, "utf8"));
    return isPlain(v) ? v : {};
  };
  const base = read(path.join(baseDir, `${name}.yaml`));
  const user = read(path.join(dataPaths(dataDir).configDir, `${name}.yaml`));
  return deepMerge(base, user);
}

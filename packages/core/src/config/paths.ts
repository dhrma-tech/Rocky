import os from "node:os";
import path from "node:path";

/** Per-OS application data root, before the `Rocky` folder. */
export function appDataRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") return env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

/** Fixed layout inside the data dir. */
export function dataPaths(dataDir: string) {
  return {
    root: dataDir,
    db: path.join(dataDir, "rocky.db"),
    config: path.join(dataDir, "rocky.yaml"),
    configDir: path.join(dataDir, "config"),
    backups: path.join(dataDir, "backups"),
    blobs: path.join(dataDir, "blobs"),
    bin: path.join(dataDir, "bin"),
    models: path.join(dataDir, "models"),
    logs: path.join(dataDir, "logs"),
  };
}
export type DataPaths = ReturnType<typeof dataPaths>;

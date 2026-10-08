import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "@rocky/contracts";
import YAML from "yaml";
import { loadAppConfig, saveAppConfig } from "../config/load.ts";
import { dataPaths } from "../config/paths.ts";
import type { SecretStore } from "../secrets/keychain.ts";
import { cipherDriver, isEncryptedFile, openDb } from "./db.ts";

/**
 * The key for the store, or undefined for a plain one (SECURITY.md "Data at rest", opt-in).
 * A brand-new encrypted store gets a fresh random key in the keychain.
 */
export function storeKey(
  config: AppConfig,
  secrets: SecretStore,
  dbFile: string,
): string | undefined {
  if (!config.storage.encrypt) return undefined;
  const key = secrets.get("db-key");
  if (key) return key;
  if (fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0)
    throw new Error(
      isEncryptedFile(dbFile)
        ? "The store is encrypted, but its key (db-key) is not in the keychain. Restore the key; without it the data cannot be read."
        : "storage.encrypt is on but the store is not encrypted yet. Run `rocky db encrypt`.",
    );
  const fresh = randomBytes(32).toString("hex");
  secrets.set("db-key", fresh);
  return fresh;
}

export interface EncryptResult {
  backupsEncrypted: number;
}

/** Rekeys one plain SQLite file in place. WAL must be off for the rekey. */
function rekeyFile(file: string, key: string): void {
  const Driver = cipherDriver();
  const db = new Driver(file);
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
    db.pragma("cipher = 'sqlcipher'");
    db.pragma(`rekey = "x'${key}'"`);
  } finally {
    db.close();
  }
}

/**
 * `rocky db encrypt`: encrypts an existing plain store and its migration backups in place, then
 * turns storage.encrypt on. The key is stored in the keychain before any file changes, so a
 * failure part-way never leaves data encrypted under a key that was lost. The daemon must be
 * stopped (the caller checks).
 */
export function encryptStore(dataDir: string, secrets: SecretStore): EncryptResult {
  const paths = dataPaths(dataDir);
  if (!fs.existsSync(paths.db)) throw new Error(`No store at ${paths.db}.`);
  if (isEncryptedFile(paths.db)) throw new Error("The store is already encrypted.");
  const key = secrets.get("db-key") ?? randomBytes(32).toString("hex");
  secrets.set("db-key", key);

  rekeyFile(paths.db, key);
  // Prove it opens with the key before the config says it is encrypted.
  openDb(paths.db, { key }).close();

  let backupsEncrypted = 0;
  if (fs.existsSync(paths.backups))
    for (const f of fs.readdirSync(paths.backups).filter((n) => n.endsWith(".db"))) {
      const file = path.join(paths.backups, f);
      if (isEncryptedFile(file)) continue;
      rekeyFile(file, key);
      backupsEncrypted++;
    }

  saveAppConfig(dataDir, { ...loadAppConfig(dataDir), storage: { encrypt: true } });
  return { backupsEncrypted };
}

/** For doctor and `rocky db status`. */
export function storageStatus(
  dataDir: string,
  config: AppConfig,
): { configured: boolean; encrypted: boolean } {
  return {
    configured: config.storage.encrypt,
    encrypted: isEncryptedFile(dataPaths(dataDir).db),
  };
}

/** The user's own `storage.encrypt` from rocky.yaml, or undefined when they never set it. */
function explicitEncryptSetting(dataDir: string): boolean | undefined {
  const file = dataPaths(dataDir).config;
  if (!fs.existsSync(file)) return undefined;
  const raw = (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as {
    storage?: { encrypt?: unknown };
  };
  return typeof raw.storage?.encrypt === "boolean" ? raw.storage.encrypt : undefined;
}

/**
 * Encryption on by default (roadmap M5): a brand-new store is created encrypted, with a random key
 * in the OS keychain, unless the user set `storage.encrypt` themselves, the SQLCipher driver is
 * missing, or the keychain can't hold the key (then it stays plain and doctor says so). An
 * existing plain store is never converted silently: `rocky db encrypt` does that, with a backup.
 */
export function encryptNewStore(
  dataDir: string,
  config: AppConfig,
  secrets: SecretStore,
  dbFile: string,
): AppConfig {
  if (config.storage.encrypt) return config;
  if (fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0) return config;
  if (explicitEncryptSetting(dataDir) !== undefined) return config;
  try {
    cipherDriver();
  } catch {
    return config;
  }
  try {
    const key = secrets.get("db-key") ?? randomBytes(32).toString("hex");
    secrets.set("db-key", key);
    if (secrets.get("db-key") !== key) return config;
  } catch {
    return config;
  }
  const next: AppConfig = { ...config, storage: { ...config.storage, encrypt: true } };
  saveAppConfig(dataDir, next);
  return next;
}

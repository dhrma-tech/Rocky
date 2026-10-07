import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "@rocky/contracts";
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

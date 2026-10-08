import { createInterface } from "node:readline/promises";
import {
  dataPaths,
  encryptStore,
  keychainSecrets,
  loadAppConfig,
  openDb,
  resolveDataDir,
  rollback,
  storageStatus,
  storeKey,
} from "@rocky/core";
import { daemonClient } from "./commands.ts";

/**
 * `rocky db status | encrypt`: SQLCipher encryption of the store (SECURITY.md "Data at rest").
 * The key lives only in the OS keychain; losing it loses the data, so encrypt asks first.
 */
export async function dbCommand(
  action: string,
  opts: { dataDir?: string | undefined; yes?: boolean; to?: string },
): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  if (action === "rollback") return rollbackCommand(dir, opts);
  if (action === "status") {
    const s = storageStatus(dir, loadAppConfig(dir));
    console.log(
      s.encrypted
        ? "The store is encrypted (SQLCipher). Its key is in the OS keychain as rocky/db-key."
        : "The store is not encrypted. Use OS disk encryption (BitLocker, Device Encryption, FileVault), or run `rocky db encrypt`.",
    );
    if (s.configured !== s.encrypted)
      console.log("Warning: rocky.yaml storage.encrypt does not match the file on disk.");
    return 0;
  }
  if (action !== "encrypt") {
    console.error(`Unknown action "${action}". Use: status | encrypt | rollback`);
    return 1;
  }
  if (await daemonClient(dir)) {
    console.error("Stop the daemon first; the store must not be open while it is encrypted.");
    return 1;
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.error("Re-run with --yes to confirm.");
      return 1;
    }
    console.log(
      "This encrypts the store and its backups with a key kept only in the OS keychain.\n" +
        "If that keychain entry is lost (new machine, OS reset), the data cannot be recovered.",
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^y(es)?$/i.test((await rl.question("Encrypt now? [y/N] ")).trim());
    rl.close();
    if (!ok) return 1;
  }
  try {
    const r = encryptStore(dir, keychainSecrets());
    console.log(
      `Encrypted the store${r.backupsEncrypted ? ` and ${r.backupsEncrypted} backup(s)` : ""}. storage.encrypt is now on.`,
    );
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

/**
 * `rocky db rollback --to <version>`: reverses schema migrations with their down scripts, after a
 * backup, for going back to an older Rocky. This version migrates forward again on its next start.
 */
async function rollbackCommand(dir: string, opts: { yes?: boolean; to?: string }): Promise<number> {
  const to = Number(opts.to);
  if (!Number.isInteger(to) || to < 0) {
    console.error("Usage: rocky db rollback --to <schema version> [--yes]");
    return 1;
  }
  if (await daemonClient(dir)) {
    console.error("Stop the daemon first; the store must not be open during a rollback.");
    return 1;
  }
  if (!opts.yes) {
    console.error(
      `Re-run with --yes to roll the schema back to version ${to}. A backup is made first.`,
    );
    return 1;
  }
  const paths = dataPaths(dir);
  const db = openDb(paths.db, { key: storeKey(loadAppConfig(dir), keychainSecrets(), paths.db) });
  try {
    const r = rollback(db, to, { backupDir: paths.backups });
    console.log(
      r.from === r.to
        ? `Nothing to roll back: the schema is at version ${r.from}.`
        : `Rolled the schema back from ${r.from} to ${r.to}. A backup is in ${paths.backups}.`,
    );
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  } finally {
    db.close();
  }
}

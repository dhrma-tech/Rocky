import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type Db = Database.Database;

export interface OpenDbOptions {
  readonly?: boolean;
  /** Load the sqlite-vec extension (default true). */
  vec?: boolean;
  /**
   * Encryption key (64 hex chars, from the keychain). With a key the store opens through
   * better-sqlite3-multiple-ciphers in SQLCipher mode (SECURITY.md "Data at rest", opt-in).
   */
  key?: string | undefined;
}

export const DB_KEY_RE = /^[0-9a-f]{64}$/;

const require = createRequire(import.meta.url);

/** The SQLCipher-capable driver, loaded only when a store is encrypted (optional dependency). */
export function cipherDriver(): typeof Database {
  try {
    return require("better-sqlite3-multiple-ciphers") as typeof Database;
  } catch {
    throw new Error(
      "This store is encrypted, but better-sqlite3-multiple-ciphers is not installed. Run `pnpm i`.",
    );
  }
}

/** Applies the SQLCipher key; a wrong key fails here, on the first read. */
export function applyKey(db: Db, key: string): void {
  if (!DB_KEY_RE.test(key)) throw new Error("The database key must be 64 hex characters.");
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key = "x'${key}'"`);
  try {
    db.prepare("select count(*) from sqlite_master").get();
  } catch {
    throw new Error(
      "Cannot open the encrypted store: the key in the keychain does not match. Restore the key or a backup.",
    );
  }
}

/** Opens the store with Rocky's pragmas. Pass ":memory:" for an in-memory DB. */
export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const Driver = opts.key ? cipherDriver() : Database;
  const db = new Driver(file, { readonly: opts.readonly ?? false });
  try {
    if (opts.key) applyKey(db, opts.key);
    else if (file !== ":memory:" && fs.existsSync(file) && fs.statSync(file).size > 0)
      assertPlain(db);
    if (file !== ":memory:" && !opts.readonly) db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    if (opts.vec ?? true) sqliteVec.load(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** A plain driver on an encrypted file fails with "file is not a database"; say why. */
function assertPlain(db: Db): void {
  try {
    db.prepare("select count(*) from sqlite_master").get();
  } catch (err) {
    if (/not a database/i.test(String(err)))
      throw new Error(
        "The store looks encrypted, but storage.encrypt is off in rocky.yaml. Set it back to true.",
      );
    throw err;
  }
}

/** True when the file on disk is not a plain SQLite database (encrypted pages have no header). */
export function isEncryptedFile(file: string): boolean {
  if (!fs.existsSync(file) || fs.statSync(file).size < 16) return false;
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    return head.toString("latin1") !== "SQLite format 3\u0000";
  } finally {
    fs.closeSync(fd);
  }
}

/** Reports whether sqlite-vec loads and registers its functions on this machine. */
export function vecStatus(): { ok: true; version: string } | { ok: false; error: string } {
  let db: Db | undefined;
  try {
    db = openDb(":memory:");
    const row = db.prepare("select vec_version() as v").get() as { v: string };
    return { ok: true, version: row.v };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type Db = Database.Database;

export interface OpenDbOptions {
  readonly?: boolean;
  /** Load the sqlite-vec extension (default true). */
  vec?: boolean;
}

/** Opens the store with Rocky's pragmas. Pass ":memory:" for an in-memory DB. */
export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly: opts.readonly ?? false });
  if (file !== ":memory:" && !opts.readonly) db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (opts.vec ?? true) sqliteVec.load(db);
  return db;
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

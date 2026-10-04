import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

export const defaultMigrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url));

const FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const KEEP_BACKUPS = 3;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Reads `NNN_name.sql` files in order. Gaps and duplicates are errors. */
export function readMigrations(dir: string): Migration[] {
  if (!fs.existsSync(dir)) return [];
  const migrations = fs
    .readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .map((name) => ({
      version: Number(name.slice(0, 3)),
      name,
      sql: fs.readFileSync(path.join(dir, name), "utf8"),
    }));
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(`Migration numbering broken at ${m.name}: expected ${i + 1}`);
  });
  return migrations;
}

export interface MigrateOptions {
  dir?: string;
  /** Backup folder. Required for file DBs that already have applied migrations. */
  backupDir?: string;
  now?: () => number;
}

/**
 * Applies pending forward-only migrations. Before each run on an existing DB, the DB is copied
 * (VACUUM INTO) to `backupDir/rocky-<ver>-<ts>.db`; the newest 3 backups are kept.
 * Each migration runs in one transaction together with its `PRAGMA user_version` bump.
 */
export function migrate(db: Db, opts: MigrateOptions = {}): { from: number; to: number } {
  const migrations = readMigrations(opts.dir ?? defaultMigrationsDir);
  const from = db.pragma("user_version", { simple: true }) as number;
  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from };

  if (from > 0 && !db.memory) {
    if (!opts.backupDir) throw new Error("backupDir is required to migrate an existing database");
    backup(db, opts.backupDir, from, (opts.now ?? Date.now)());
  }

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return { from, to: pending.at(-1)?.version ?? from };
}

function backup(db: Db, dir: string, version: number, ts: number): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `rocky-${version}-${ts}.db`);
  db.prepare("VACUUM INTO ?").run(target);
  const old = fs
    .readdirSync(dir)
    .filter((f) => /^rocky-\d+-\d+\.db$/.test(f))
    .sort((a, b) => Number(a.split("-")[2]?.slice(0, -3)) - Number(b.split("-")[2]?.slice(0, -3)));
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS)))
    fs.rmSync(path.join(dir, f));
}

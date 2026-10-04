import fs from "node:fs";
import path from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { ulid } from "ulid";
import { deleteDocument } from "../ingest/delete.ts";
import { ingestFile } from "../ingest/ingest-file.ts";
import { parserFor } from "../ingest/parsers/index.ts";
import { LOCAL_CONNECTOR } from "../ingest/upsert.ts";
import type { Db } from "../store/db.ts";

export interface WatchedFolder {
  id: string;
  path: string;
  recursive: boolean;
  enabled: boolean;
  createdAt: number;
}

interface Row {
  id: string;
  path: string;
  recursive: number;
  enabled: number;
  created_at: number;
}
const toFolder = (r: Row): WatchedFolder => ({
  id: r.id,
  path: r.path,
  recursive: r.recursive === 1,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
});

export function listWatchedFolders(db: Db): WatchedFolder[] {
  return (db.prepare("select * from watched_folders order by created_at").all() as Row[]).map(
    toFolder,
  );
}

export function addWatchedFolder(
  db: Db,
  folder: string,
  opts: { recursive?: boolean; now?: number } = {},
): WatchedFolder {
  const abs = path.resolve(folder);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory())
    throw new Error(`Not a folder: ${abs}`);
  const existing = db.prepare("select * from watched_folders where path = ?").get(abs) as
    | Row
    | undefined;
  if (existing) return toFolder(existing);
  const row: Row = {
    id: ulid(),
    path: abs,
    recursive: opts.recursive === false ? 0 : 1,
    enabled: 1,
    created_at: opts.now ?? Date.now(),
  };
  db.prepare(
    "insert into watched_folders (id, path, recursive, enabled, created_at) values (?, ?, ?, ?, ?)",
  ).run(row.id, row.path, row.recursive, row.enabled, row.created_at);
  return toFolder(row);
}

/** Stops watching; documents already imported stay until deleted explicitly. */
export function removeWatchedFolder(db: Db, idOrPath: string): boolean {
  const abs = path.resolve(idOrPath);
  return (
    db.prepare("delete from watched_folders where id = ? or path = ?").run(idOrPath, abs).changes >
    0
  );
}

export interface WatcherDeps {
  db: Db;
  blobsDir: string;
  /** Called after each ingest so the job runner picks up embedding at once. */
  onIngested?: () => void;
  log?: (msg: string) => void;
  /** How long a file's size must stay stable before it is read (default 1.5 s). */
  settleMs?: number;
}

const isHidden = (p: string) =>
  path.basename(p).startsWith(".") || path.basename(p).startsWith("~$");

/**
 * WatchedFolderSource (capture.md): chokidar on every enabled folder. Supported files are
 * ingested on add/change (idempotent: unchanged content is a no-op) and removed from memory on
 * unlink. The initial scan reconciles files that changed while the daemon was off.
 */
export class FolderWatcher {
  private readonly watchers: FSWatcher[] = [];
  private readonly deps: WatcherDeps;
  /** Serializes ingests so SQLite writes and parser memory stay bounded. */
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: WatcherDeps) {
    this.deps = deps;
  }

  /** Starts (or restarts) watching the enabled folders. Resolves after the initial scan. */
  async start(): Promise<void> {
    await this.stop();
    const folders = listWatchedFolders(this.deps.db).filter((f) => f.enabled);
    // One watcher per folder: chokidar's depth is per watcher (0 = this folder only).
    await Promise.all(folders.map((f) => this.watchFolder(f)));
    this.removeMissing(folders);
    await this.idle();
  }

  private async watchFolder(f: WatchedFolder): Promise<void> {
    const w = watch(f.path, {
      ignoreInitial: false,
      ...(f.recursive ? {} : { depth: 0 }),
      awaitWriteFinish: {
        stabilityThreshold: this.deps.settleMs ?? 1500,
        pollInterval: Math.min(250, this.deps.settleMs ?? 250),
      },
      ignored: (p, stats) => isHidden(p) || (Boolean(stats?.isFile()) && !parserFor(p)),
    });
    this.watchers.push(w);
    w.on("add", (p) => this.enqueue("ingest", p));
    w.on("change", (p) => this.enqueue("ingest", p));
    w.on("unlink", (p) => this.enqueue("remove", p));
    w.on("error", (e) => this.deps.log?.(`watch error: ${e instanceof Error ? e.message : e}`));
    await new Promise<void>((resolve) => w.once("ready", () => resolve()));
  }

  /** Files deleted while nothing was watching: their documents are removed on the next start. */
  private removeMissing(folders: WatchedFolder[]) {
    const docs = this.deps.db
      .prepare("select external_id from documents where connector_id = ?")
      .all(LOCAL_CONNECTOR) as { external_id: string }[];
    for (const { external_id: file } of docs) {
      const watched = folders.some((f) =>
        f.recursive ? file.startsWith(f.path + path.sep) : path.dirname(file) === f.path,
      );
      if (watched && !fs.existsSync(file)) this.enqueue("remove", file);
    }
  }

  /** Resolves once every queued ingest/remove has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  async stop(): Promise<void> {
    await Promise.all(this.watchers.splice(0).map((w) => w.close()));
    await this.queue;
  }

  private enqueue(kind: "ingest" | "remove", file: string) {
    this.queue = this.queue.then(() => this.handle(kind, file)).catch(() => {});
  }

  private async handle(kind: "ingest" | "remove", file: string): Promise<void> {
    const { db, blobsDir, log } = this.deps;
    try {
      if (kind === "remove") {
        const doc = db
          .prepare("select id from documents where connector_id = ? and external_id = ?")
          .get(LOCAL_CONNECTOR, path.resolve(file)) as { id: string } | undefined;
        if (doc) {
          deleteDocument(db, blobsDir, doc.id);
          log?.(`removed ${file}`);
        }
        return;
      }
      if (!parserFor(file)) return;
      const r = await ingestFile(db, blobsDir, file);
      if (r.status === "skipped") log?.(`skipped ${file}: ${r.reason}`);
      else if (r.status !== "unchanged") {
        log?.(`${r.status} ${file}`);
        this.deps.onIngested?.();
      }
    } catch (err) {
      log?.(
        `watch ${kind} failed for ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

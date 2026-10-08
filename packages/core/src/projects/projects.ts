import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { z } from "zod";
import { appendAudit } from "../audit/append.ts";
import { addWatchedFolder, listWatchedFolders } from "../capture/watch.ts";
import { materialize } from "../notebooks/scope.ts";
import { createNotebook, updateNotebook } from "../notebooks/service.ts";
import type { Db } from "../store/db.ts";

/**
 * Projects (UI spec 12, D-017, D-047): one piece of work, a name and a folder. Creating one
 * watches the folder (Rocky can't see it until you pick it) and makes a project notebook scoped
 * to it, so chat, briefs and retrieval inside the project use only that folder.
 */

export interface Project {
  id: string;
  name: string;
  folder: string;
  notebookId: string | null;
  /** False when the folder moved or was deleted ("This folder moved or was deleted"). */
  folderExists: boolean;
  documentCount: number;
  createdAt: number;
  archivedAt: number | null;
}

export const ProjectCreateSchema = z
  .object({ name: z.string().trim().min(1).max(120), folder: z.string().min(1).max(1000) })
  .strict();

interface Row {
  id: string;
  name: string;
  folder: string;
  notebook_id: string | null;
  created_at: number;
  archived_at: number | null;
}

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

function toProject(db: Db, r: Row): Project {
  const count = r.notebook_id
    ? (
        db
          .prepare("select count(*) as n from notebook_sources where notebook_id = ?")
          .get(r.notebook_id) as { n: number }
      ).n
    : 0;
  return {
    id: r.id,
    name: r.name,
    folder: r.folder,
    notebookId: r.notebook_id,
    folderExists: fs.existsSync(r.folder),
    documentCount: count,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

export function listProjects(db: Db, opts: { archived?: boolean } = {}): Project[] {
  return (
    db
      .prepare(
        `select * from projects where archived_at is ${opts.archived ? "not null" : "null"} order by created_at desc`,
      )
      .all() as Row[]
  ).map((r) => toProject(db, r));
}

export function getProject(db: Db, id: string): Project {
  const r = db.prepare("select * from projects where id = ?").get(id) as Row | undefined;
  if (!r) throw fail("NOT_FOUND", "Project not found");
  return toProject(db, r);
}

export function createProject(
  db: Db,
  input: z.input<typeof ProjectCreateSchema>,
  now = Date.now(),
): Project {
  const p = ProjectCreateSchema.parse(input);
  const folder = path.resolve(p.folder);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
    throw fail("BAD_REQUEST", `${folder} isn't a folder on this computer.`);
  if (db.prepare("select 1 from projects where folder = ? and archived_at is null").get(folder))
    throw fail("ILLEGAL_TRANSITION", "A project already uses this folder.");
  if (!listWatchedFolders(db).some((w) => path.resolve(w.path) === folder))
    addWatchedFolder(db, folder, { now });
  const nb = createNotebook(
    db,
    {
      name: p.name,
      kind: "project",
      scope: { documentIds: [], excludedIds: [], rules: { localFolders: [folder] } },
    },
    now,
  );
  const id = ulid(now);
  db.prepare(
    "insert into projects (id, name, folder, notebook_id, created_at) values (?, ?, ?, ?, ?)",
  ).run(id, p.name, folder, nb.id, now);
  materialize(db, nb.id);
  appendAudit(db, {
    eventType: "project_created",
    actor: "user",
    subjectType: "project",
    subjectId: id,
    meta: { folder },
  });
  return getProject(db, id);
}

export function renameProject(db: Db, id: string, name: string): Project {
  const p = getProject(db, id);
  const n = z.string().trim().min(1).max(120).parse(name);
  db.prepare("update projects set name = ? where id = ?").run(n, id);
  if (p.notebookId) updateNotebook(db, p.notebookId, { name: n });
  return getProject(db, id);
}

/** "Change folder" and "Locate" after a move: the scope follows the new folder. */
export function moveProject(db: Db, id: string, folder: string, now = Date.now()): Project {
  const p = getProject(db, id);
  const abs = path.resolve(folder);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory())
    throw fail("BAD_REQUEST", `${abs} isn't a folder on this computer.`);
  if (!listWatchedFolders(db).some((w) => path.resolve(w.path) === abs))
    addWatchedFolder(db, abs, { now });
  db.prepare("update projects set folder = ? where id = ?").run(abs, id);
  if (p.notebookId) {
    updateNotebook(db, p.notebookId, {
      scope: { documentIds: [], excludedIds: [], rules: { localFolders: [abs] } },
    });
    materialize(db, p.notebookId);
  }
  return getProject(db, id);
}

/** Archive keeps history (runs, documents, the notebook); nothing is deleted. */
export function archiveProject(db: Db, id: string, now = Date.now()): Project {
  getProject(db, id);
  db.prepare("update projects set archived_at = ? where id = ? and archived_at is null").run(
    now,
    id,
  );
  appendAudit(db, {
    eventType: "project_archived",
    actor: "user",
    subjectType: "project",
    subjectId: id,
  });
  return getProject(db, id);
}

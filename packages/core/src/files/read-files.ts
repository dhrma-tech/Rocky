import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LOCAL_CONNECTOR } from "../ingest/upsert.ts";
import type { Db } from "../store/db.ts";

/**
 * Files (UI spec 14): every local file Rocky read. Rocky never creates, changes or deletes files
 * outside its data folder, so "read" is the whole trace; the screen says so for the other actions.
 */

export interface ReadFile {
  documentId: string;
  name: string;
  path: string;
  mime: string | null;
  /** When Rocky last read it. */
  readAt: number;
  /** Bytes on disk now; null when the file is gone. */
  size: number | null;
  exists: boolean;
  /** Characters of text Rocky took from it. */
  textChars: number;
}

interface Row {
  id: string;
  external_id: string;
  title: string;
  mime: string | null;
  ingested_at: number;
  chars: number;
}

export function listReadFiles(db: Db, opts: { q?: string; limit?: number } = {}): ReadFile[] {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  // "!" escapes LIKE wildcards, so a % or _ in the search is literal.
  const like = opts.q?.trim() ? `%${opts.q.trim().replace(/[%_!]/g, "!$&")}%` : null;
  const filter = like ? "and (external_id like ? escape '!' or title like ? escape '!')" : "";
  const rows = db
    .prepare(
      `select id, external_id, title, mime, ingested_at, length(raw_text) as chars from documents
       where connector_id = ? ${filter}
       order by ingested_at desc limit ?`,
    )
    .all(...(like ? [LOCAL_CONNECTOR, like, like, limit] : [LOCAL_CONNECTOR, limit])) as Row[];
  return rows.map((r) => {
    let size: number | null = null;
    try {
      size = fs.statSync(r.external_id).size;
    } catch {
      // Moved or deleted since Rocky read it.
    }
    return {
      documentId: r.id,
      name: path.basename(r.external_id),
      path: r.external_id,
      mime: r.mime,
      readAt: r.ingested_at,
      size,
      exists: size !== null,
      textChars: r.chars,
    };
  });
}

const PREVIEW_CHARS = 4000;

/** The start of the text Rocky took from a file (what it actually read), not the file itself. */
export function readFilePreview(
  db: Db,
  documentId: string,
): { text: string; truncated: boolean } | null {
  const r = db
    .prepare("select raw_text from documents where id = ? and connector_id = ?")
    .get(documentId, LOCAL_CONNECTOR) as { raw_text: string } | undefined;
  if (!r) return null;
  return {
    text: r.raw_text.slice(0, PREVIEW_CHARS),
    truncated: r.raw_text.length > PREVIEW_CHARS,
  };
}

/**
 * Shows the file in the system file manager. The path comes from the store, never from the
 * request, and is passed as an argument (no shell).
 */
export function revealReadFile(
  db: Db,
  documentId: string,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => void = (cmd, args) =>
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(),
): "revealed" | "missing" | "unknown" {
  const r = db
    .prepare("select external_id from documents where id = ? and connector_id = ?")
    .get(documentId, LOCAL_CONNECTOR) as { external_id: string } | undefined;
  if (!r) return "unknown";
  if (!fs.existsSync(r.external_id)) return "missing";
  if (platform === "win32") run("explorer.exe", [`/select,${r.external_id}`]);
  else if (platform === "darwin") run("open", ["-R", r.external_id]);
  else run("xdg-open", [path.dirname(r.external_id)]);
  return "revealed";
}

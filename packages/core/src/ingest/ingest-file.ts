import fs from "node:fs";
import path from "node:path";
import { enqueue } from "../jobs/queue.ts";
import { putBlob } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";
import { EMBED_JOB } from "./embed-job.ts";
import { parserFor } from "./parsers/index.ts";
import { type UpsertResult, upsertDocument } from "./upsert.ts";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".vtt": "text/vtt",
};

export type IngestFileResult =
  | (UpsertResult & { path: string })
  | { status: "skipped"; path: string; reason: string };

/**
 * Parses one local file, stores its original bytes as a blob (the source viewer renders PDFs
 * from it), upserts the document and queues embedding. The external id is the absolute path.
 */
export async function ingestFile(
  db: Db,
  blobsDir: string,
  filePath: string,
): Promise<IngestFileResult> {
  const abs = path.resolve(filePath);
  const parser = parserFor(abs);
  if (!parser) return { status: "skipped", path: abs, reason: "unsupported file type" };
  const bytes = fs.readFileSync(abs);
  const stat = fs.statSync(abs);
  const parsed = await parser.parse({ bytes, filename: path.basename(abs) });
  if (!parsed.text.trim())
    return { status: "skipped", path: abs, reason: "no extractable text (scanned PDF?)" };
  const blobHash = putBlob(blobsDir, bytes);
  const res = upsertDocument(db, {
    parsed,
    externalId: abs,
    uri: `file:///${abs.replace(/\\/g, "/").replace(/^\//, "")}`,
    mime: MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    blobHash,
    createdAt: Math.round(stat.birthtimeMs || stat.mtimeMs),
    updatedAt: Math.round(stat.mtimeMs),
  });
  if (res.status !== "unchanged")
    enqueue(db, EMBED_JOB, { documentId: res.documentId }, { priority: 1 });
  return { ...res, path: abs };
}

/** Walks a directory (or takes a single file) and ingests every supported file. */
export async function ingestPath(
  db: Db,
  blobsDir: string,
  target: string,
): Promise<IngestFileResult[]> {
  const abs = path.resolve(target);
  if (fs.statSync(abs).isFile()) return [await ingestFile(db, blobsDir, abs)];
  const out: IngestFileResult[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const full = path.join(entry.parentPath, entry.name);
    if (parserFor(full)) out.push(await ingestFile(db, blobsDir, full));
  }
  return out;
}

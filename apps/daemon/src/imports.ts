import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  type ArchiveFormatName,
  ArchiveFormatSchema,
  ArchiveImportPathSchema,
  type ArchiveImportResult,
  type ArchiveImportRow,
} from "@rocky/contracts";
import {
  deleteData,
  persistSourceDocuments,
  prepareSourceDocuments,
  type Runtime,
} from "@rocky/core";
import {
  type ArchiveFiles,
  filesFromZipStream,
  importConnectorId,
  MAX_TEXT_BYTES,
  parseArchive,
  readArchive,
  UnrecognizedArchive,
} from "@rocky/importers";
import type { Hono } from "hono";
import type { z } from "zod";

class UploadTooLarge extends Error {}

/** Upload cap for a browser-sent export. Media is skipped, but zips carry it, so allow 2 GB. */
const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;

/**
 * Parses an export and stores its conversations as documents under `import:<format>`, queueing
 * embedding. The daemon and the CLI both call it; core never imports the importers.
 */
export async function importArchive(
  rt: Runtime,
  archive: ArchiveFiles,
  format?: ArchiveFormatName,
): Promise<ArchiveImportResult> {
  const parsed = parseArchive(archive, format);
  let skipped = 0;
  const prepared = await prepareSourceDocuments(parsed.documents, () => {
    skipped++;
  });
  const counts = persistSourceDocuments(
    rt.db,
    rt.paths.blobs,
    importConnectorId(parsed.format),
    prepared,
  );
  return {
    format: parsed.format,
    archive: archive.name,
    documents: parsed.documents.length,
    messages: parsed.messages,
    ...counts,
    skipped,
    warnings: parsed.warnings,
  };
}

export function listArchiveImports(rt: Runtime): ArchiveImportRow[] {
  const rows = rt.db
    .prepare(
      `select substr(connector_id, 8) as format, coalesce(json_extract(meta, '$.archive'), '') as archive,
              count(*) as documents, coalesce(sum(json_extract(meta, '$.messages')), 0) as messages,
              max(ingested_at) as importedAt
       from documents where connector_id like 'import:%'
       group by connector_id, archive order by importedAt desc`,
    )
    .all() as ArchiveImportRow[];
  return rows.filter((r) => ArchiveFormatSchema.safeParse(r.format).success);
}

/** Deletes everything one import produced (DeletionService: chunks, cards, audit payloads). */
export function deleteArchiveImport(rt: Runtime, format: ArchiveFormatName, archive: string) {
  const ids = (
    rt.db
      .prepare(
        "select id from documents where connector_id = ? and coalesce(json_extract(meta, '$.archive'), '') = ?",
      )
      .all(importConnectorId(format), archive) as { id: string }[]
  ).map((r) => r.id);
  return ids.length ? deleteData(rt.db, rt.paths.blobs, { documentIds: ids }) : { documents: 0 };
}

type Body = <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) => Promise<T>;

const errorJson = (err: unknown) =>
  err instanceof UnrecognizedArchive
    ? { status: 422 as const, body: { error: err.message, code: "UNRECOGNIZED_ARCHIVE" } }
    : null;

/** Import panel (Connectors screen): upload or point at an export, list and remove imports. */
export function registerImportRoutes(
  api: Hono,
  { rt, poke, body }: { rt: Runtime; poke?: (() => void) | undefined; body: Body },
): void {
  api.get("/imports/archives", (c) => c.json({ imports: listArchiveImports(rt) }));

  api.post("/imports/archive/path", async (c) => {
    const input = await body(c, ArchiveImportPathSchema);
    if (!fs.existsSync(input.path))
      return c.json({ error: `No such file or folder: ${input.path}`, code: "NOT_FOUND" }, 404);
    try {
      const r = await importArchive(rt, await readArchive(input.path), input.format);
      poke?.();
      return c.json(r, 201);
    } catch (err) {
      const e = errorJson(err);
      if (e) return c.json(e.body, e.status);
      throw err;
    }
  });

  // The browser streams the raw file; ?filename= names it (.zip, .txt, .js, .csv or .json).
  api.post("/imports/archive", async (c) => {
    const filename = path.basename(c.req.query("filename") ?? "");
    if (!/\.(zip|txt|js|csv|json)$/i.test(filename))
      return c.json(
        { error: "Upload a .zip export, or a .txt, .js, .csv or .json file.", code: "BAD_REQUEST" },
        400,
      );
    const format = ArchiveFormatSchema.optional().safeParse(c.req.query("format") || undefined);
    if (!format.success) return c.json({ error: "unknown format", code: "BAD_REQUEST" }, 400);
    const stream = c.req.raw.body;
    if (!stream) return c.json({ error: "empty upload", code: "BAD_REQUEST" }, 400);
    const isZip = /\.zip$/i.test(filename);
    // Zips stream through the unzipper (media is never held); plain text files are buffered.
    const cap = isZip ? MAX_ARCHIVE_BYTES : MAX_TEXT_BYTES;
    let size = 0;
    async function* limited() {
      for await (const chunk of Readable.fromWeb(stream as WebReadableStream)) {
        size += (chunk as Uint8Array).length;
        if (size > cap) throw new UploadTooLarge();
        yield chunk as Uint8Array;
      }
    }
    try {
      let archive: ArchiveFiles;
      if (isZip) archive = await filesFromZipStream(filename, limited());
      else {
        const parts: Uint8Array[] = [];
        for await (const chunk of limited()) parts.push(chunk);
        archive = {
          name: filename.replace(/\.[^.]+$/, ""),
          files: new Map([[filename, new Uint8Array(Buffer.concat(parts))]]),
        };
      }
      if (size === 0) return c.json({ error: "empty upload", code: "BAD_REQUEST" }, 400);
      const r = await importArchive(rt, archive, format.data);
      poke?.();
      return c.json(r, 201);
    } catch (err) {
      if (err instanceof UploadTooLarge)
        return c.json(
          { error: `Export is larger than ${isZip ? "2 GB" : "512 MB"}`, code: "BAD_REQUEST" },
          413,
        );
      const e = errorJson(err);
      if (e) return c.json(e.body, e.status);
      throw err;
    }
  });

  api.delete("/imports/archives/:format", (c) => {
    const format = ArchiveFormatSchema.safeParse(c.req.param("format"));
    if (!format.success) return c.json({ error: "unknown format", code: "BAD_REQUEST" }, 400);
    return c.json(deleteArchiveImport(rt, format.data, c.req.query("archive") ?? ""));
  });
}

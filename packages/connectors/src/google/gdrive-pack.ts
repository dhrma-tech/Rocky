import { createHash } from "node:crypto";
import type { ConnectorAction, ExecContext } from "@rocky/connector-sdk";
import { z } from "zod";
import { gjson } from "./common.ts";

/**
 * Drive source pack (notebooks.md "Exports"). Verified 2026-10-07:
 * - Multipart upload: POST /upload/drive/v3/files?uploadType=multipart, multipart/related with a
 *   JSON metadata part then the media part (≤ 5 MB). mimeType application/vnd.google-apps.document
 *   in the metadata converts the HTML into a Google Doc. Update: PATCH /upload/drive/v3/files/{id}.
 * - Search: q = appProperties has { key='k' and value='v' }.
 * - Scope drive.file: the app sees only files it created, so the pack folder is created by Rocky
 *   and found again through its appProperties. One Doc per course per ISO week; a re-run replaces it.
 */

const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const API = "https://www.googleapis.com/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";
export const PACK_FOLDER_NAME = "Rocky source packs";
const MAX_HTML = 4_000_000;

export const SourcePackSchema = z
  .object({
    course: z.string().trim().min(1).max(200),
    /** ISO week, e.g. 2026-W41. */
    week: z.string().regex(/^\d{4}-W\d{2}$/),
    title: z.string().trim().min(1).max(300),
    html: z.string().min(1).max(MAX_HTML),
  })
  .strict();
export type SourcePack = z.infer<typeof SourcePackSchema>;

interface DFile {
  id: string;
  webViewLink?: string;
}

const q = (key: string, value: string) =>
  `appProperties has { key='${key}' and value='${value}' } and trashed=false`;

async function findOne(ctx: ExecContext, query: string): Promise<DFile | null> {
  const r = await gjson<{ files?: DFile[] }>(
    ctx,
    `${API}?q=${encodeURIComponent(query)}&pageSize=1&fields=${encodeURIComponent("files(id,webViewLink)")}`,
  );
  return r.files?.[0] ?? null;
}

async function packFolder(ctx: ExecContext): Promise<string> {
  const found = await findOne(ctx, q("rocky", "sourcepacks"));
  if (found) return found.id;
  const created = await gjson<DFile>(ctx, `${API}?fields=id`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: PACK_FOLDER_NAME,
      mimeType: FOLDER,
      appProperties: { rocky: "sourcepacks" },
    }),
    signal: ctx.signal,
  });
  return created.id;
}

/** multipart/related body: JSON metadata, then the HTML. */
export function multipart(metadata: unknown, html: string, boundary: string): string {
  return [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Stable per course and week, so a second export replaces the Doc instead of adding one. */
export const packKey = (p: SourcePack) =>
  createHash("sha256").update(`${p.course}\n${p.week}`).digest("hex").slice(0, 32);

export const sourcePackWrite: ConnectorAction<SourcePack> = {
  type: "gdrive.sourcePackWrite",
  title: "Write Drive source pack",
  schema: SourcePackSchema,
  risk: "low",
  describe: (p) => ({
    target: `Google Drive / ${PACK_FOLDER_NAME}`,
    summary: `Google Doc "${p.title}" (${p.course}, ${p.week}); replaces that week's Doc if it exists`,
  }),
  async execute(p, ctx) {
    const key = packKey(p);
    const boundary = `rocky${ctx.idempotencyKey.replace(/\W/g, "")}`;
    const headers = { "content-type": `multipart/related; boundary=${boundary}` };
    const existing = await findOne(ctx, q("rockyPack", key));
    if (existing) {
      const f = await gjson<DFile>(
        ctx,
        `${UPLOAD}/${existing.id}?uploadType=multipart&fields=id,webViewLink`,
        {
          method: "PATCH",
          headers,
          body: multipart({ name: p.title }, p.html, boundary),
          signal: ctx.signal,
        },
      );
      return { fileId: f.id, url: f.webViewLink ?? null, replaced: true };
    }
    const folder = await packFolder(ctx);
    const f = await gjson<DFile>(ctx, `${UPLOAD}?uploadType=multipart&fields=id,webViewLink`, {
      method: "POST",
      headers,
      body: multipart(
        { name: p.title, mimeType: DOC, parents: [folder], appProperties: { rockyPack: key } },
        p.html,
        boundary,
      ),
      signal: ctx.signal,
    });
    return { fileId: f.id, url: f.webViewLink ?? null };
  },
};

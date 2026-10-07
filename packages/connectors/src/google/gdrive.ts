import type { Connector, SourceDocument } from "@rocky/connector-sdk";
import { z } from "zod";
import { type GoogleCtx, gfetch, gjson, googleOAuth } from "./common.ts";
import { sourcePackWrite } from "./gdrive-pack.ts";

/**
 * Google Drive read-sync (CONNECTORS.md #3), read-only by default. Verified 2026-10-06:
 * changes.getStartPageToken (doesn't expire) then changes.list (pageToken required,
 * newStartPageToken on the last page); Docs export as text/markdown, Slides as text/plain
 * (exports capped at 10 MB); PDFs via files.get alt=media and parsed locally.
 * Not yet: shared drives (supportsAllDrives), Sheets.
 */

const API = "https://www.googleapis.com/drive/v3";
const DOC = "application/vnd.google-apps.document";
const SLIDES = "application/vnd.google-apps.presentation";
const PDF = "application/pdf";
const FIELDS =
  "id,name,mimeType,createdTime,modifiedTime,webViewLink,size,trashed,parents,owners(displayName,emailAddress),appProperties";
/** Folder depth followed when resolving a file's ancestors (notebook rules match recursively). */
const MAX_DEPTH = 8;

export const GdriveConfigSchema = z.object({
  backfillDays: z.number().int().min(1).max(3650).default(90),
  maxFileMb: z.number().int().min(1).max(100).default(10),
});
export type GdriveConfig = z.infer<typeof GdriveConfigSchema>;
export interface GdriveCursor {
  pageToken: string;
}

interface DFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  webViewLink?: string;
  size?: string;
  trashed?: boolean;
  owners?: { displayName?: string; emailAddress?: string }[];
  appProperties?: Record<string, string>;
  parents?: string[];
}

/** Every folder above a file, resolved once per sync and cached (notebook "Drive folder" rules). */
export function ancestorResolver(ctx: GoogleCtx) {
  const cache = new Map<string, string[]>();
  const parentsOf = async (id: string): Promise<string[]> => {
    const hit = cache.get(id);
    if (hit) return hit;
    let parents: string[] = [];
    try {
      parents =
        (await gjson<{ parents?: string[] }>(ctx, `${API}/files/${id}?fields=parents`)).parents ??
        [];
    } catch {
      // A folder we can't read ends the chain.
    }
    cache.set(id, parents);
    return parents;
  };
  return async (direct: string[] = []): Promise<string[]> => {
    const out = new Set<string>();
    let level = direct;
    for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
      const next: string[] = [];
      for (const id of level) {
        if (out.has(id)) continue;
        out.add(id);
        next.push(...(await parentsOf(id)));
      }
      level = next;
    }
    return [...out];
  };
}

export const SUPPORTED = new Set([DOC, SLIDES, PDF]);

export function fileToDocument(
  ctx: GoogleCtx,
  f: DFile,
  maxBytes: number,
  ancestors: string[] = f.parents ?? [],
): SourceDocument | null {
  if (!SUPPORTED.has(f.mimeType)) return null;
  // Source packs Rocky wrote are exports of memory, not new sources.
  if (f.appProperties?.rockyPack) return null;
  if (f.mimeType === PDF && Number(f.size ?? 0) > maxBytes) return null;
  const owner = f.owners?.[0];
  const base = {
    externalId: f.id,
    title: f.name,
    ...(f.webViewLink ? { uri: f.webViewLink } : {}),
    ...(owner
      ? {
          author: {
            ...(owner.displayName ? { name: owner.displayName } : {}),
            ...(owner.emailAddress ? { email: owner.emailAddress } : {}),
          },
        }
      : {}),
    createdAt: Date.parse(f.createdTime),
    updatedAt: Date.parse(f.modifiedTime),
    meta: { driveMime: f.mimeType, ancestors },
  };
  const text = async (mime: string) =>
    (await gfetch(ctx, `${API}/files/${f.id}/export?mimeType=${encodeURIComponent(mime)}`)).text();
  if (f.mimeType === PDF)
    return {
      ...base,
      sourceType: "pdf",
      mime: PDF,
      body: {
        kind: "binary",
        filename: f.name.toLowerCase().endsWith(".pdf") ? f.name : `${f.name}.pdf`,
        fetch: async () =>
          new Uint8Array(await (await gfetch(ctx, `${API}/files/${f.id}?alt=media`)).arrayBuffer()),
      },
    };
  // Google Docs and Slides are exported lazily, when the core persists the batch.
  const exportMime = f.mimeType === DOC ? "text/markdown" : "text/plain";
  return {
    ...base,
    sourceType: f.mimeType === DOC ? "markdown" : "text",
    mime: exportMime,
    body: {
      kind: "binary",
      filename: f.mimeType === DOC ? `${f.id}.md` : `${f.id}.txt`,
      fetch: async () => new TextEncoder().encode(await text(exportMime)),
    },
  };
}

export const gdrive: Connector<GdriveConfig, GdriveCursor> = {
  id: "gdrive",
  displayName: "Google Drive",
  permissions:
    "Reads Docs, Slides and PDFs; writes source packs into its own folder after approval",
  configSchema: GdriveConfigSchema,
  secrets: [],
  // drive.file: only files Rocky creates (the source-pack folder), Phase 6.
  oauth: googleOAuth([
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
  ]),
  defaultIntervalMin: 30,
  readOnlyCapable: true,
  async *sync(ctx, cursor) {
    const maxBytes = ctx.config.maxFileMb * 1024 * 1024;
    const ancestors = ancestorResolver(ctx);
    const toDoc = async (f: DFile) =>
      SUPPORTED.has(f.mimeType)
        ? fileToDocument(ctx, f, maxBytes, await ancestors(f.parents))
        : null;
    if (!cursor?.pageToken) {
      // Take the change token first so edits made during the backfill are picked up next time.
      const start = await gjson<{ startPageToken: string }>(ctx, `${API}/changes/startPageToken`);
      const q = `trashed=false and modifiedTime > '${new Date(ctx.since).toISOString()}' and (mimeType='${DOC}' or mimeType='${SLIDES}' or mimeType='${PDF}')`;
      let pageToken: string | undefined;
      do {
        const page: { files?: DFile[]; nextPageToken?: string } = await gjson(
          ctx,
          `${API}/files?pageSize=100&q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${FIELDS})`)}${pageToken ? `&pageToken=${pageToken}` : ""}`,
        );
        pageToken = page.nextPageToken;
        const documents: SourceDocument[] = [];
        for (const f of page.files ?? []) {
          const d = await toDoc(f);
          if (d) documents.push(d);
        }
        yield {
          documents,
          cursor: (pageToken ? undefined : { pageToken: start.startPageToken }) as GdriveCursor,
        };
      } while (pageToken);
      return;
    }
    let token: string | undefined = cursor.pageToken;
    while (token) {
      const page: {
        changes?: { fileId: string; removed?: boolean; file?: DFile }[];
        nextPageToken?: string;
        newStartPageToken?: string;
      } = await gjson(
        ctx,
        `${API}/changes?pageToken=${encodeURIComponent(token)}&pageSize=100&includeRemoved=true&fields=${encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`)}`,
      );
      const documents: SourceDocument[] = [];
      const gone: string[] = [];
      for (const c of page.changes ?? []) {
        if (c.removed || c.file?.trashed) gone.push(c.fileId);
        else if (c.file) {
          const d = await toDoc(c.file);
          if (d) documents.push(d);
        }
      }
      // A page token is a valid resume point, so each page commits its own position.
      const resume = page.nextPageToken ?? page.newStartPageToken ?? token;
      yield { documents, deletedExternalIds: gone, cursor: { pageToken: resume } };
      token = page.nextPageToken;
    }
  },
  async health(ctx) {
    const a = await gjson<{ user?: { emailAddress?: string; displayName?: string } }>(
      ctx,
      `${API}/about?fields=user`,
    );
    const who = a.user?.emailAddress ?? a.user?.displayName ?? "your account";
    return { status: "ok", message: `Reading Drive for ${who}`, account: who };
  },
  actions: () => [sourcePackWrite],
};

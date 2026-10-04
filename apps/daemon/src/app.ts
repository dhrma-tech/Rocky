import fs from "node:fs";
import path from "node:path";
import {
  AnchorSchema,
  type AskEvent,
  AskRequestSchema,
  SettingsUpdateSchema,
} from "@rocky/contracts";
import {
  addWatchedFolder,
  ask,
  blobPath,
  deleteDocument,
  ingestPath,
  listWatchedFolders,
  type Runtime,
  redact,
  removeWatchedFolder,
  SECRET_NAMES,
  type SecretName,
  saveAppConfig,
} from "@rocky/core";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type Auth, SESSION_COOKIE } from "./auth.ts";

export const VERSION = "0.0.0";

/** Errors carry a stable code (router errors) and a redacted message; nothing else leaks. */
export function errorBody(err: unknown): { error: string; code: string } {
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : "INTERNAL";
  return { error: redact(err instanceof Error ? err.message : String(err)), code };
}

const POLICY_CODES = new Set([
  "EGRESS_BLOCKED",
  "BUDGET_EXCEEDED",
  "UNKNOWN_PRICE",
  "TASK_NEEDS_API",
  "MISSING_API_KEY",
]);

const IngestBody = z.object({ path: z.string().min(1) }).strict();
const WatchBody = z.object({ path: z.string().min(1), recursive: z.boolean().optional() }).strict();
const SecretBody = z.object({ value: z.string().min(1).max(4096) }).strict();
/** The daemon token is internal; the API can only write provider keys. */
const WRITABLE_SECRETS: readonly SecretName[] = SECRET_NAMES.filter((n) => n !== "daemon-token");

interface DocRow {
  id: string;
  title: string;
  source_type: string;
  uri: string | null;
  mime: string | null;
  blob_hash: string | null;
  created_at: number | null;
  updated_at: number | null;
  local_only: number;
}

export interface AppDeps {
  rt: Runtime;
  auth: Auth;
  /** Called after an ingest so the background runner picks up embedding jobs at once. */
  poke?: () => void;
  /** Built web UI to serve at `/` (Phase 1 web shell). */
  webDir?: string;
  /** Restarts folder watching after the folder list changes. */
  rewatch?: () => Promise<void>;
}

export function createApp({ rt, auth, poke, webDir, rewatch }: AppDeps): Hono {
  const app = new Hono();
  app.use("*", auth.hostGuard());

  app.get("/api/v1/health", (c) => c.json({ ok: true, version: VERSION }));

  // One-time bootstrap: `rocky open` mints a code with the token; the browser trades it for a cookie.
  app.get("/auth/bootstrap", (c) => {
    const session = auth.redeemCode(c.req.query("code") ?? "");
    if (!session)
      return c.text("This sign-in link is invalid or expired. Run `rocky open` again.", 401);
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.redirect("/");
  });

  const api = new Hono();
  api.use("*", auth.apiGuard());

  api.onError((err, c) => {
    const body = errorBody(err);
    return c.json(body, POLICY_CODES.has(body.code) ? 409 : 500);
  });

  api.post("/auth/codes", (c) => {
    if (!auth.isBearer(c.req.header("authorization")))
      return c.json({ error: "bootstrap codes need the install token" }, 403);
    return c.json({ code: auth.issueCode() });
  });

  // --- Ask (SSE) ---
  api.post("/ask", async (c) => {
    const parsed = AskRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error), code: "BAD_REQUEST" }, 400);
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const send = (e: AskEvent) => {
        const { type, ...data } = e;
        chain = chain.then(() => stream.writeSSE({ event: type, data: JSON.stringify(data) }));
      };
      try {
        await ask({ db: rt.db, router: rt.router, embedder: rt.embedder }, parsed.data, send);
      } catch (err) {
        chain = chain.then(() =>
          stream.writeSSE({ event: "error", data: JSON.stringify(errorBody(err)) }),
        );
      }
      await chain;
    });
  });

  // --- Ingest (manual import) ---
  api.post("/ingest", async (c) => {
    const parsed = IngestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "body must be {path}", code: "BAD_REQUEST" }, 400);
    if (!fs.existsSync(parsed.data.path))
      return c.json(
        { error: `No such file or folder: ${parsed.data.path}`, code: "NOT_FOUND" },
        404,
      );
    const results = await ingestPath(rt.db, rt.paths.blobs, parsed.data.path);
    poke?.();
    return c.json({ results });
  });

  // --- Watched folders ---
  api.get("/watched-folders", (c) => c.json({ folders: listWatchedFolders(rt.db) }));

  api.post("/watched-folders", async (c) => {
    const parsed = WatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "body must be {path, recursive?}", code: "BAD_REQUEST" }, 400);
    let folder: ReturnType<typeof addWatchedFolder>;
    try {
      folder = addWatchedFolder(rt.db, parsed.data.path, {
        ...(parsed.data.recursive === undefined ? {} : { recursive: parsed.data.recursive }),
      });
    } catch (err) {
      return c.json({ error: errorBody(err).error, code: "BAD_REQUEST" }, 400);
    }
    await rewatch?.();
    return c.json({ folder });
  });

  api.delete("/watched-folders/:id", async (c) => {
    if (!removeWatchedFolder(rt.db, c.req.param("id")))
      return c.json({ error: "not a watched folder", code: "NOT_FOUND" }, 404);
    await rewatch?.();
    return c.json({ removed: true });
  });

  // --- Documents and the source viewer ---
  api.get("/documents/:id", (c) => {
    const doc = rt.db
      .prepare(
        "select id, title, source_type, uri, mime, blob_hash, created_at, updated_at, local_only from documents where id = ?",
      )
      .get(c.req.param("id")) as DocRow | undefined;
    if (!doc) return c.json({ error: "document not found", code: "NOT_FOUND" }, 404);
    return c.json({
      id: doc.id,
      title: doc.title,
      sourceType: doc.source_type,
      uri: doc.uri,
      mime: doc.mime,
      blobUrl: doc.blob_hash ? `/api/v1/blobs/${doc.blob_hash}` : null,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      localOnly: doc.local_only === 1,
    });
  });

  api.get("/documents/:id/anchor", (c) => {
    const row = rt.db
      .prepare(
        `select c.anchor, c.char_start, c.char_end, d.raw_text, d.blob_hash, d.mime, d.title
         from chunks c join documents d on d.id = c.document_id
         where c.id = ? and d.id = ?`,
      )
      .get(c.req.query("chunk") ?? "", c.req.param("id")) as
      | {
          anchor: string;
          char_start: number;
          char_end: number;
          raw_text: string;
          blob_hash: string | null;
          mime: string | null;
          title: string;
        }
      | undefined;
    if (!row) return c.json({ error: "chunk not found in document", code: "NOT_FOUND" }, 404);
    const anchor = AnchorSchema.parse(JSON.parse(row.anchor));
    const span = { charStart: row.char_start, charEnd: row.char_end };
    if (anchor.kind === "pdf_page" && row.blob_hash && row.mime === "application/pdf")
      return c.json({
        viewer: "pdf",
        title: row.title,
        blobUrl: `/api/v1/blobs/${row.blob_hash}`,
        page: anchor.page,
        anchor,
        ...span,
      });
    return c.json({ viewer: "text", title: row.title, text: row.raw_text, anchor, ...span });
  });

  api.delete("/documents/:id", (c) => {
    const ok = deleteDocument(rt.db, rt.paths.blobs, c.req.param("id"));
    return ok
      ? c.json({ deleted: true })
      : c.json({ error: "document not found", code: "NOT_FOUND" }, 404);
  });

  // Only blobs that belong to a document are served; Range requests for the PDF viewer.
  api.get("/blobs/:hash", (c) => {
    const hash = c.req.param("hash");
    const doc = rt.db.prepare("select mime from documents where blob_hash = ? limit 1").get(hash) as
      | { mime: string | null }
      | undefined;
    if (!doc || !/^[0-9a-f]{64}$/.test(hash))
      return c.json({ error: "blob not found", code: "NOT_FOUND" }, 404);
    const file = blobPath(rt.paths.blobs, hash);
    if (!fs.existsSync(file))
      return c.json({ error: "blob missing on disk", code: "NOT_FOUND" }, 404);
    const size = fs.statSync(file).size;
    const headers: Record<string, string> = {
      "content-type": doc.mime ?? "application/octet-stream",
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size)
        return c.body(null, 416, { "content-range": `bytes */${size}` });
      const buf = Buffer.alloc(end - start + 1);
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buf, 0, buf.length, start);
      } finally {
        fs.closeSync(fd);
      }
      return c.body(buf, 206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(buf.length),
      });
    }
    return c.body(fs.readFileSync(file), 200, { ...headers, "content-length": String(size) });
  });

  // --- Settings ---
  api.get("/settings", (c) =>
    c.json({
      localOnly: rt.config.localOnly,
      budget: rt.config.budget,
      ollama: rt.config.ollama,
      dataDir: rt.dataDir,
      secrets: Object.fromEntries(WRITABLE_SECRETS.map((n) => [n, rt.secrets.has(n)])),
    }),
  );

  api.put("/settings", async (c) => {
    const parsed = SettingsUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error), code: "BAD_REQUEST" }, 400);
    const u = parsed.data;
    const next = {
      ...rt.config,
      ...(u.localOnly !== undefined ? { localOnly: u.localOnly } : {}),
      ...(u.budget ? { budget: u.budget } : {}),
      ...(u.ollama ? { ollama: u.ollama } : {}),
    };
    saveAppConfig(rt.dataDir, next);
    // The gate reads rt.config on every call, so the change applies immediately.
    Object.assign(rt.config, next);
    return c.json({
      localOnly: rt.config.localOnly,
      budget: rt.config.budget,
      ollama: rt.config.ollama,
    });
  });

  // Write-only: a stored key is never returned.
  api.post("/secrets/:name", async (c) => {
    const name = c.req.param("name") as SecretName;
    if (!WRITABLE_SECRETS.includes(name))
      return c.json({ error: `unknown secret ${name}`, code: "BAD_REQUEST" }, 400);
    const parsed = SecretBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "body must be {value}", code: "BAD_REQUEST" }, 400);
    rt.secrets.set(name, parsed.data.value);
    return c.json({ stored: true });
  });

  api.get("/system/hardware", (c) => c.json(rt.hardware));

  api.get("/usage", (c) => {
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) return c.json({ error: "month must be YYYY-MM", code: "BAD_REQUEST" }, 400);
    const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
    const to = Date.UTC(Number(m[1]), Number(m[2]), 1);
    const rows = rt.db
      .prepare(
        `select task, provider, model, local, count(*) as calls, sum(input_tokens) as inputTokens,
                sum(output_tokens) as outputTokens, sum(cost_usd) as costUsd
         from usage_log where at >= ? and at < ? group by task, provider, model, local order by costUsd desc`,
      )
      .all(from, to) as { costUsd: number; local: number }[];
    const spent = rows.filter((r) => r.local === 0).reduce((s, r) => s + r.costUsd, 0);
    return c.json({ month, spentUsd: spent, capUsd: rt.config.budget.monthlyCapUsd, rows });
  });

  app.route("/api/v1", api);

  if (webDir) mountWeb(app, webDir);
  return app;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".mjs": "text/javascript",
};

/** Serves the built web UI; unknown paths fall back to index.html (client-side routing). */
function mountWeb(app: Hono, webDir: string) {
  const root = fs.realpathSync(webDir);
  const index = path.join(root, "index.html");
  app.get("*", (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
    let file: string;
    try {
      file = fs.realpathSync(path.join(root, rel));
    } catch {
      file = index;
    }
    // realpath resolves "..", symlinks and junctions; anything outside the web root gets index.html.
    if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) file = index;
    const ext = path.extname(file);
    return c.body(fs.readFileSync(file), 200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'",
    });
  });
}

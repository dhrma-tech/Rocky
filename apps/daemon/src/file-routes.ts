import { listReadFiles, type Runtime, readFilePreview, revealReadFile } from "@rocky/core";
import type { Hono } from "hono";
import { z } from "zod";

/** Files (UI spec 14): what Rocky read from this computer, a preview, and Open in folder. */
export function registerFileRoutes(api: Hono, { rt }: { rt: Runtime }): void {
  const Query = z.object({ q: z.string().max(200).optional() });
  api.get("/files", (c) => {
    const q = Query.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "bad query", code: "BAD_REQUEST" }, 400);
    return c.json({ files: listReadFiles(rt.db, q.data.q ? { q: q.data.q } : {}) });
  });
  api.get("/files/:id/preview", (c) => {
    const p = readFilePreview(rt.db, c.req.param("id"));
    return p ? c.json(p) : c.json({ error: "file not found", code: "NOT_FOUND" }, 404);
  });
  api.post("/files/:id/reveal", (c) => {
    const r = revealReadFile(rt.db, c.req.param("id"));
    if (r === "unknown") return c.json({ error: "file not found", code: "NOT_FOUND" }, 404);
    if (r === "missing")
      return c.json({ error: "This file is no longer on disk.", code: "GONE" }, 410);
    return c.json({ revealed: true });
  });
}

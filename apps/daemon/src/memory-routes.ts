import {
  forgetFact,
  listMemory,
  MemoryError,
  memoryHistory,
  type Runtime,
  readMemoryContent,
  rememberUserFact,
  saveMemoryFile,
  suggestMemories,
} from "@rocky/core";
import type { Hono } from "hono";
import { z } from "zod";

/** Memory screen (UI spec 13, roadmap A5). The files live on disk; the screen says where. */

const PathQ = z.object({ path: z.string().min(1).max(200) });
const SaveBody = z
  .object({ path: z.string(), content: z.string().max(200_000), baseHash: z.string() })
  .strict();
const FactBody = z.object({ path: z.string(), fact: z.string().trim().min(3).max(300) }).strict();
const ForgetBody = z.object({ path: z.string(), index: z.number().int().nonnegative() }).strict();
const SuggestBody = z.object({ documentId: z.string().min(1) }).strict();

type Body = <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) => Promise<T>;

export function registerMemoryRoutes(api: Hono, { rt, body }: { rt: Runtime; body: Body }): void {
  api.get("/memory", (c) => c.json({ dir: rt.paths.memory, files: listMemory(rt.dataDir) }));
  api.get("/memory/file", (c) => {
    const q = PathQ.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "path is required", code: "BAD_REQUEST" }, 400);
    return c.json(readMemoryContent(rt.dataDir, q.data.path));
  });
  api.get("/memory/history", (c) => {
    const q = PathQ.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "path is required", code: "BAD_REQUEST" }, 400);
    return c.json({ versions: memoryHistory(rt.dataDir, q.data.path) });
  });
  api.put("/memory/file", async (c) => {
    const b = await body(c, SaveBody);
    try {
      return c.json(saveMemoryFile(rt.db, rt.dataDir, b.path, b.content, b.baseHash));
    } catch (err) {
      // "This file changed": the screen shows both versions, so send the current one.
      if (err instanceof MemoryError && err.code === "CONFLICT")
        return c.json({ error: err.message, code: err.code, current: err.current ?? "" }, 409);
      throw err;
    }
  });
  api.post("/memory/fact", async (c) => {
    const b = await body(c, FactBody);
    return c.json(rememberUserFact(rt.db, rt.dataDir, b.path, b.fact), 201);
  });
  api.post("/memory/forget", async (c) => {
    const b = await body(c, ForgetBody);
    return c.json(forgetFact(rt.db, rt.dataDir, b.path, b.index));
  });
  api.post("/memory/suggest", async (c) => {
    const b = await body(c, SuggestBody);
    return c.json(
      await suggestMemories({ db: rt.db, router: rt.router, actions: rt.actions }, b.documentId),
    );
  });
}

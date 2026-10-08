import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  moveProject,
  ProjectCreateSchema,
  type Runtime,
  renameProject,
} from "@rocky/core";
import type { Hono } from "hono";
import { z } from "zod";

/** Projects (UI spec 12): a name and a folder; the folder is watched as soon as it is picked. */

type Body = <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) => Promise<T>;
const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    folder: z.string().min(1).max(1000).optional(),
  })
  .strict();

export function registerProjectRoutes(
  api: Hono,
  { rt, body, rewatch }: { rt: Runtime; body: Body; rewatch: () => Promise<void> },
): void {
  api.get("/projects", (c) =>
    c.json({ projects: listProjects(rt.db, { archived: c.req.query("archived") === "1" }) }),
  );
  api.get("/projects/:id", (c) => c.json(getProject(rt.db, c.req.param("id"))));
  api.post("/projects", async (c) => {
    const p = createProject(rt.db, await body(c, ProjectCreateSchema));
    await rewatch();
    return c.json(p, 201);
  });
  api.patch("/projects/:id", async (c) => {
    const b = await body(c, PatchBody);
    const id = c.req.param("id");
    if (b.name) renameProject(rt.db, id, b.name);
    if (b.folder) {
      moveProject(rt.db, id, b.folder);
      await rewatch();
    }
    return c.json(getProject(rt.db, id));
  });
  api.post("/projects/:id/archive", (c) => c.json(archiveProject(rt.db, c.req.param("id"))));
}

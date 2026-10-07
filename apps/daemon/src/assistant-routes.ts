import {
  type AskEvent,
  BriefRequestSchema,
  DraftRequestSchema,
  RoutineCreateSchema,
  RoutineUpdateSchema,
} from "@rocky/contracts";
import {
  addPackRoutines,
  briefForEvent,
  briefForNotebook,
  createRoutine,
  deleteRoutine,
  draftEmail,
  enqueue,
  getRoutine,
  home,
  latestBrief,
  listPacks,
  listRoutines,
  ROUTINE_JOB,
  type Runtime,
  routineRuns,
  timeline,
  updateRoutine,
} from "@rocky/core";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

type Body = <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) => Promise<T>;
type ErrorBody = (err: unknown) => { error: string; code: string };

/**
 * Runs `work` as an SSE stream: progress events while it runs, then `done` with the result, or
 * `error` with the stable error body (same framing as POST /ask).
 */
export function sse<T>(
  c: Context,
  errorBody: ErrorBody,
  work: (send: (e: AskEvent | { type: string; [k: string]: unknown }) => void) => Promise<T>,
) {
  return streamSSE(c, async (stream) => {
    let chain = Promise.resolve();
    const send = (e: { type: string; [k: string]: unknown }) => {
      const { type, ...data } = e;
      chain = chain.then(() => stream.writeSSE({ event: type, data: JSON.stringify(data) }));
    };
    try {
      const result = await work(send);
      send({ type: "done", result });
    } catch (err) {
      chain = chain.then(() =>
        stream.writeSSE({ event: "error", data: JSON.stringify(errorBody(err)) }),
      );
    }
    await chain;
  });
}

/** Assistant layer routes (ui.md "Home & Brief", "Routines", "Drafts"; Phase 6). */
export function registerAssistantRoutes(
  api: Hono,
  {
    rt,
    body,
    errorBody,
    poke,
  }: { rt: Runtime; body: Body; errorBody: ErrorBody; poke?: (() => void) | undefined },
): void {
  const deps = { db: rt.db, router: rt.router, ...(rt.embedder ? { embedder: rt.embedder } : {}) };

  // --- briefs ---
  api.post("/briefs", async (c) => {
    const req = await body(c, BriefRequestSchema);
    return sse(c, errorBody, (send) =>
      "eventId" in req
        ? briefForEvent(deps, req.eventId, { onEvent: send })
        : briefForNotebook(deps, req.notebookId, { onEvent: send }),
    );
  });
  api.get("/briefs/latest", (c) => {
    const q = z
      .object({ kind: z.enum(["event", "notebook"]), subject: z.string().min(1) })
      .safeParse(c.req.query());
    if (!q.success)
      return c.json({ error: "kind and subject are required", code: "BAD_REQUEST" }, 400);
    return c.json({ brief: latestBrief(rt.db, q.data.kind, q.data.subject) });
  });

  // --- drafts (proposal for gmail.draftCreate; reaches Gmail only after approval) ---
  api.post("/drafts", async (c) => {
    const req = await body(c, DraftRequestSchema);
    return sse(c, errorBody, (send) =>
      draftEmail(
        { ...deps, actions: rt.actions, hasType: (t) => Boolean(rt.registry.get(t)) },
        req,
        send,
      ),
    );
  });

  // --- home and timeline ---
  api.get("/home", (c) => c.json(home(rt.db)));
  api.get("/timeline", (c) => {
    const q = z
      .object({ from: z.coerce.number().int(), to: z.coerce.number().int() })
      .refine(
        (r) => r.to > r.from && r.to - r.from <= 366 * 86_400_000,
        "from < to, at most a year",
      )
      .safeParse(c.req.query());
    if (!q.success)
      return c.json({ error: "from and to (ms) are required", code: "BAD_REQUEST" }, 400);
    return c.json({ items: timeline(rt.db, q.data) });
  });

  // --- routines ---
  const opts = () => ({ dataDir: rt.dataDir });
  api.get("/templates", (c) => c.json({ packs: listPacks(rt.dataDir) }));
  api.get("/routines", (c) => c.json({ routines: listRoutines(rt.db, opts()) }));
  api.post("/routines", async (c) => {
    const id = createRoutine(rt.db, await body(c, RoutineCreateSchema));
    return c.json(getRoutine(rt.db, id, opts()), 201);
  });
  api.post("/routines/from-template", async (c) => {
    const { pack, template } = await body(
      c,
      z.object({ pack: z.string().min(1), template: z.string().min(1).optional() }).strict(),
    );
    const added = addPackRoutines(rt.db, pack, {
      ...opts(),
      ...(template ? { only: template } : {}),
    });
    return c.json({ added, routines: listRoutines(rt.db, opts()) }, 201);
  });
  api.get("/routines/:id", (c) => c.json(getRoutine(rt.db, c.req.param("id"), opts())));
  api.patch("/routines/:id", async (c) => {
    updateRoutine(rt.db, c.req.param("id"), await body(c, RoutineUpdateSchema));
    return c.json(getRoutine(rt.db, c.req.param("id"), opts()));
  });
  api.delete("/routines/:id", (c) => {
    deleteRoutine(rt.db, c.req.param("id"));
    return c.json({ deleted: true });
  });
  /** Run now: queued like a scheduled run; the UI follows GET /jobs/:id/events. */
  api.post("/routines/:id/run", (c) => {
    const id = c.req.param("id");
    getRoutine(rt.db, id, opts());
    const jobId = enqueue(
      rt.db,
      ROUTINE_JOB,
      { routineId: id, at: Date.now() },
      {
        heavy: rt.router.chain("routine", {})[0]?.local ?? true,
        priority: 1,
        maxAttempts: 1,
      },
    );
    poke?.();
    return c.json({ jobId }, 202);
  });
  api.get("/routines/:id/runs", (c) => c.json({ runs: routineRuns(rt.db, c.req.param("id")) }));
}

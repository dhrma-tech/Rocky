import { type AskEvent, BriefRequestSchema } from "@rocky/contracts";
import { briefForEvent, briefForNotebook, latestBrief, type Runtime } from "@rocky/core";
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
  { rt, body, errorBody }: { rt: Runtime; body: Body; errorBody: ErrorBody },
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
}

import { eventsAfter, type Runtime } from "@rocky/core";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

/**
 * The typed event stream (UI spec "Agent UI", roadmap A10).
 * - GET /events: SSE. Replays every event after `Last-Event-ID` (set by EventSource on reconnect)
 *   or `?after=`, then follows new ones. Each message carries `id: seq` and `event: kind`.
 * - GET /events/page: the same events as JSON pages, for the ledger and tests.
 * Readers poll the table, so events written by the CLI appear too.
 */

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

const Query = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  runId: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

export function registerEventRoutes(api: Hono, { rt }: { rt: Runtime }): void {
  api.get("/events/page", (c) => {
    const q = Query.safeParse(c.req.query());
    if (!q.success) return c.json({ error: z.prettifyError(q.error), code: "BAD_REQUEST" }, 400);
    const events = eventsAfter(rt.db, q.data.after, {
      limit: q.data.limit,
      ...(q.data.runId ? { runId: q.data.runId } : {}),
    });
    return c.json({ events, last: events.at(-1)?.seq ?? q.data.after });
  });

  api.get("/events", (c) => {
    const q = Query.safeParse(c.req.query());
    if (!q.success) return c.json({ error: z.prettifyError(q.error), code: "BAD_REQUEST" }, 400);
    const resume = Number(c.req.header("last-event-id"));
    let last = Number.isInteger(resume) && resume > 0 ? resume : q.data.after;
    const runId = q.data.runId;
    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      let quiet = 0;
      while (!aborted) {
        const batch = eventsAfter(rt.db, last, { limit: 500, ...(runId ? { runId } : {}) });
        for (const e of batch) {
          await stream.writeSSE({ id: String(e.seq), event: e.kind, data: JSON.stringify(e) });
          last = e.seq;
        }
        if (batch.length === 500) continue; // more backlog: no wait
        quiet = batch.length ? 0 : quiet + POLL_MS;
        // A comment line keeps proxies and the browser from timing the stream out.
        if (quiet >= HEARTBEAT_MS) {
          await stream.write(": keep-alive\n\n");
          quiet = 0;
        }
        await stream.sleep(POLL_MS);
      }
    });
  });
}

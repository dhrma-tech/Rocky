import { NotificationIdsSchema, NotificationListQuerySchema, SnoozeSchema } from "@rocky/contracts";
import {
  dismissNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  type Runtime,
  snoozeNotifications,
} from "@rocky/core";
import type { Hono } from "hono";
import { z } from "zod";

/**
 * Notifications (UI spec 16).
 * - GET /notifications?tab=all|needs_you|updates&after=<id>: newest first, plus the unread count.
 * - POST /notifications/read {ids}, /notifications/read-all, /notifications/snooze {ids, until},
 *   /notifications/dismiss {ids}.
 * The notifier in the daemon writes them from the event stream; nothing here creates one.
 */
export function registerNotificationRoutes(api: Hono, { rt }: { rt: Runtime }): void {
  const bad = (error: z.ZodError) => ({ error: z.prettifyError(error), code: "BAD_REQUEST" });
  const json = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);

  api.get("/notifications", (c) => {
    const q = NotificationListQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json(bad(q.error), 400);
    return c.json(listNotifications(rt.db, q.data));
  });
  api.post("/notifications/read", async (c) => {
    const b = NotificationIdsSchema.safeParse(await json(c));
    if (!b.success) return c.json(bad(b.error), 400);
    return c.json({ changed: markNotificationsRead(rt.db, b.data.ids) });
  });
  api.post("/notifications/read-all", (c) => c.json({ changed: markAllNotificationsRead(rt.db) }));
  api.post("/notifications/snooze", async (c) => {
    const b = SnoozeSchema.safeParse(await json(c));
    if (!b.success) return c.json(bad(b.error), 400);
    return c.json({ changed: snoozeNotifications(rt.db, b.data.ids, b.data.until) });
  });
  api.post("/notifications/dismiss", async (c) => {
    const b = NotificationIdsSchema.safeParse(await json(c));
    if (!b.success) return c.json(bad(b.error), 400);
    return c.json({ changed: dismissNotifications(rt.db, b.data.ids) });
  });
}

import { appendAudit, ChannelBlocked, type ChannelHost, type Runtime } from "@rocky/core";
import type { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "./auth.ts";

/**
 * Phone channels (roadmap A3, D-065). Their secrets go straight to the channel host process and
 * are never read back.
 * - GET /channels: which secrets are set (yes or no), and whether local-only blocks sending.
 * - POST /channels/ntfy/secret {name: topic|token, value} (this computer only).
 * - DELETE /channels/ntfy: forget the topic and token.
 * - POST /channels/test: one test message through ntfy.
 * The on/off switch, the server and "include details" are notification preferences (/settings).
 */

const SecretBody = z
  .object({ name: z.enum(["topic", "token"]), value: z.string().trim().min(1).max(200) })
  .strict();

export function registerChannelRoutes(
  api: Hono,
  { rt, auth, channels }: { rt: Runtime; auth: Auth; channels: ChannelHost | undefined },
): void {
  const missing = {
    error: "Phone channels aren't available in this process.",
    code: "UNAVAILABLE",
  };

  api.get("/channels", async (c) => {
    if (!channels) return c.json(missing, 503);
    return c.json({ ...(await channels.status()), localOnly: rt.config.localOnly });
  });

  api.post("/channels/ntfy/secret", auth.localOnly(), async (c) => {
    if (!channels) return c.json(missing, 503);
    const b = SecretBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: z.prettifyError(b.error), code: "BAD_REQUEST" }, 400);
    // A topic is a path segment on the server: letters, digits, - and _ (ntfy's own rule).
    if (b.data.name === "topic" && !/^[A-Za-z0-9_-]{1,64}$/.test(b.data.value))
      return c.json(
        { error: "A topic uses letters, digits, - and _ only (64 at most).", code: "BAD_REQUEST" },
        400,
      );
    await channels.setSecret(
      b.data.name === "topic" ? "channel.ntfy-topic" : "channel.ntfy-token",
      b.data.value,
    );
    return c.json({ stored: true });
  });

  api.delete("/channels/ntfy", auth.localOnly(), async (c) => {
    if (!channels) return c.json(missing, 503);
    await channels.deleteSecrets();
    return c.json({ deleted: true });
  });

  api.post("/channels/test", async (c) => {
    if (!channels) return c.json(missing, 503);
    try {
      await channels.sendNtfy({
        title: "Rocky",
        text: "Notifications from Rocky work.",
        priority: "default",
      });
    } catch (err) {
      const blocked = err instanceof ChannelBlocked;
      return c.json(
        {
          error: err instanceof Error ? err.message : String(err),
          code: blocked ? "EGRESS_BLOCKED" : "SEND_FAILED",
        },
        blocked ? 409 : 502,
      );
    }
    appendAudit(rt.db, {
      eventType: "notification_sent",
      actor: "user",
      subjectType: "notification",
      subjectId: "test",
      meta: { channel: "ntfy", kind: "test" },
    });
    return c.json({ sent: true });
  });
}

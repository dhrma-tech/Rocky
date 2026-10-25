import { appendAudit, ChannelBlocked, type ChannelHost, type Runtime } from "@rocky/core";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Auth } from "./auth.ts";

/**
 * Phone channels (roadmap A3, D-065, D-066). Their secrets go straight to the channel host
 * process and are never read back.
 * - GET /channels: which secrets are set (yes or no), the Telegram bot's name, the last person
 *   who sent the bot /start without being allowed, and whether local-only blocks sending.
 * - POST /channels/ntfy/secret {name: topic|token, value}, POST /channels/telegram/token {value}
 *   (this computer only). Saving a bot token checks it with Telegram and returns the bot's name.
 * - DELETE /channels/ntfy, DELETE /channels/telegram: forget that channel's secrets.
 * - POST /channels/test {channel}: one test message.
 * On/off switches, the allowed Telegram users, the server and "include details" are notification
 * preferences (/settings).
 */

const NtfySecretBody = z
  .object({ name: z.enum(["topic", "token"]), value: z.string().trim().min(1).max(200) })
  .strict();
// Telegram bot tokens look like 123456789:AA… (digits, a colon, then letters, digits, - and _).
const TokenBody = z
  .object({
    value: z
      .string()
      .trim()
      .regex(/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/, "a bot token from @BotFather"),
  })
  .strict();
const TestBody = z.object({ channel: z.enum(["ntfy", "telegram"]).default("ntfy") }).strict();

const failure = (c: Context, err: unknown) => {
  const blocked = err instanceof ChannelBlocked;
  return c.json(
    {
      error: err instanceof Error ? err.message : String(err),
      code: blocked ? "EGRESS_BLOCKED" : "SEND_FAILED",
    },
    blocked ? 409 : 502,
  );
};

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
    const b = NtfySecretBody.safeParse(await c.req.json().catch(() => null));
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

  api.post("/channels/telegram/token", auth.localOnly(), async (c) => {
    if (!channels) return c.json(missing, 503);
    const b = TokenBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: z.prettifyError(b.error), code: "BAD_REQUEST" }, 400);
    await channels.setSecret("channel.telegram-token", b.data.value);
    try {
      return c.json({ stored: true, bot: await channels.telegramIdentity() });
    } catch (err) {
      // Kept, so it works once local-only is off; the answer says it couldn't be checked.
      return c.json({
        stored: true,
        bot: null,
        warning: err instanceof Error ? err.message : String(err),
      });
    }
  });

  for (const channel of ["ntfy", "telegram"] as const)
    api.delete(`/channels/${channel}`, auth.localOnly(), async (c) => {
      if (!channels) return c.json(missing, 503);
      await channels.deleteSecrets(channel);
      return c.json({ deleted: true });
    });

  api.post("/channels/test", async (c) => {
    if (!channels) return c.json(missing, 503);
    const b = TestBody.safeParse((await c.req.json().catch(() => null)) ?? {});
    if (!b.success) return c.json({ error: z.prettifyError(b.error), code: "BAD_REQUEST" }, 400);
    const text = "Notifications from Rocky work.";
    try {
      if (b.data.channel === "ntfy")
        await channels.sendNtfy({ title: "Rocky", text, priority: "default" });
      else {
        const ids = rt.config.notifications.telegram.userIds;
        if (!ids.length) throw new ChannelBlocked("Allow your Telegram account first.");
        for (const chatId of ids) await channels.sendTelegram({ chatId, text });
      }
    } catch (err) {
      return failure(c, err);
    }
    appendAudit(rt.db, {
      eventType: "notification_sent",
      actor: "user",
      subjectType: "notification",
      subjectId: "test",
      meta: { channel: b.data.channel, kind: "test" },
    });
    return c.json({ sent: true });
  });
}

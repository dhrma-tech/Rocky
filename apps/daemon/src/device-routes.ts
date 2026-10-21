import { HostNameSchema } from "@rocky/contracts";
import {
  appendAudit,
  createDevice,
  DEVICE_TTL_MS,
  listDevices,
  type Runtime,
  revokeDevice,
  saveAppConfig,
} from "@rocky/core";
import type { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { type Auth, DEVICE_COOKIE } from "./auth.ts";

/**
 * Phones (roadmap A3, docs/PHONE.md). Rocky listens on 127.0.0.1 only; a phone reaches it through
 * `tailscale serve`, which ends HTTPS on this computer. Pairing:
 * - POST /api/v1/devices/pair-code (on this computer only): a 6-digit code, valid 5 minutes.
 * - POST /auth/pair {code, name} (from the phone's /pair page): sets the device cookie.
 * - GET /api/v1/devices, POST /api/v1/devices/:id/revoke, PUT /api/v1/devices/hosts (this
 *   computer only): the names a phone may use.
 */

const PairBody = z
  .object({
    code: z.string().regex(/^\d{6}$/, "six digits"),
    name: z.string().trim().min(1).max(60),
  })
  .strict();
const HostsBody = z.object({ hosts: z.array(HostNameSchema).max(10) }).strict();

export function registerPairRoute(app: Hono, { rt, auth }: { rt: Runtime; auth: Auth }): void {
  app.post("/auth/pair", async (c) => {
    // A form post from the /pair page carries our Origin (hostGuard checked it matches).
    if (!c.req.header("origin")) return c.json({ error: "origin required" }, 403);
    const b = PairBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: z.prettifyError(b.error), code: "BAD_REQUEST" }, 400);
    if (!auth.redeemPairCode(b.data.code))
      return c.json(
        {
          error: "That code is wrong or has expired. Make a new one on your computer.",
          code: "PAIR_FAILED",
        },
        401,
      );
    const { device, token } = rt.db.transaction(() => {
      const made = createDevice(rt.db, b.data.name);
      appendAudit(rt.db, {
        eventType: "device_paired",
        actor: "user",
        subjectType: "device",
        subjectId: made.device.id,
        meta: { host: c.req.header("host") ?? null },
      });
      return made;
    })();
    setCookie(c, DEVICE_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.floor(DEVICE_TTL_MS / 1000),
    });
    return c.json({ paired: device.id, name: device.name });
  });
}

export function registerDeviceRoutes(api: Hono, { rt, auth }: { rt: Runtime; auth: Auth }): void {
  api.get("/devices", (c) =>
    c.json({
      devices: listDevices(rt.db),
      hosts: rt.config.daemon.allowedHosts,
      port: rt.config.daemon.port,
    }),
  );
  api.post("/devices/pair-code", auth.localOnly(), (c) => {
    if (!rt.config.daemon.allowedHosts.length)
      return c.json(
        { error: "Add the name your phone will use first.", code: "NO_ALLOWED_HOST" },
        409,
      );
    return c.json(auth.issuePairCode());
  });
  api.post("/devices/:id/revoke", (c) => {
    const id = c.req.param("id");
    const done = rt.db.transaction(() => {
      const ok = revokeDevice(rt.db, id);
      if (ok)
        appendAudit(rt.db, {
          eventType: "device_revoked",
          actor: "user",
          subjectType: "device",
          subjectId: id,
        });
      return ok;
    })();
    if (!done) return c.json({ error: "no such paired device", code: "NOT_FOUND" }, 404);
    return c.json({ revoked: id });
  });
  api.put("/devices/hosts", auth.localOnly(), async (c) => {
    const b = HostsBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: z.prettifyError(b.error), code: "BAD_REQUEST" }, 400);
    const hosts = [...new Set(b.data.hosts)];
    const next = { ...rt.config, daemon: { ...rt.config.daemon, allowedHosts: hosts } };
    saveAppConfig(rt.dataDir, next);
    // Auth reads the list on every request, so the change applies at once.
    Object.assign(rt.config, next);
    return c.json({ hosts });
  });
}

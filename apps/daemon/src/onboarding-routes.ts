import {
  isFirstRun,
  loadOnboarding,
  loadPolicy,
  OnboardingPatchSchema,
  type Runtime,
  testApiKey,
  updateOnboarding,
} from "@rocky/core";
import type { Hono } from "hono";
import type { z } from "zod";

/** Onboarding (UI spec 3, D-048): saved progress, Rocky's name and colour, the boundary preset. */

type Body = <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) => Promise<T>;

export function registerOnboardingRoutes(
  api: Hono,
  { rt, body }: { rt: Runtime; body: Body },
): void {
  const view = () => {
    const s = loadOnboarding(rt.dataDir);
    return { ...s, firstRun: isFirstRun(rt.db, s) };
  };
  api.get("/onboarding", (c) => c.json(view()));
  api.patch("/onboarding", async (c) => {
    updateOnboarding(rt.dataDir, rt.db, rt.actions.rules, await body(c, OnboardingPatchSchema));
    return c.json(view());
  });
  // Uses the key already saved through POST /secrets/anthropic; the key never travels here.
  api.post("/onboarding/test-key", async (c) =>
    c.json(
      await testApiKey(rt.gate, loadPolicy(rt.dataDir), {
        hardware: rt.hardware,
        localOnly: rt.config.localOnly,
      }),
    ),
  );
}

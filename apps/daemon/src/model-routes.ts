import {
  benchModel,
  chooseStarter,
  listLocalModels,
  loadPolicy,
  loadSpeedProfile,
  type Runtime,
  recommendModels,
  saveSpeedProfile,
  setupStarterModel,
  updateUserYaml,
} from "@rocky/core";
import type { Hono } from "hono";
import { z } from "zod";
import { type ErrorBody, sse } from "./assistant-routes.ts";

/** Settings > Model and onboarding step 2 (roadmap A8): what is installed, what fits, how fast. */

const UseBody = z
  .object({ small: z.string().min(1).max(200), medium: z.string().min(1).max(200) })
  .strict();
const strip = (s: string | undefined) =>
  s?.replace(/^ollama\//, "").replace(/:latest$/, "") ?? null;

export function registerModelRoutes(
  api: Hono,
  { rt, errorBody }: { rt: Runtime; errorBody: ErrorBody },
): void {
  api.get("/models", async (c) => {
    const policy = loadPolicy(rt.dataDir);
    const current = {
      small: strip(policy.models["local:small"]),
      medium: strip(policy.models["local:medium"]),
    };
    const speed = loadSpeedProfile(rt.dataDir);
    // What a first-run download would fetch on this machine (roadmap A1).
    const s = chooseStarter(policy, rt.hardware);
    const starter = s ? { pull: s.pull, use: s.use } : null;
    try {
      const installed = await listLocalModels(rt.config.ollama.baseUrl);
      return c.json({
        ollama: true,
        hardware: rt.hardware,
        current,
        speed,
        starter,
        ...recommendModels(rt.hardware, installed),
      });
    } catch (err) {
      return c.json({
        ollama: false,
        error: err instanceof Error ? err.message : String(err),
        hardware: rt.hardware,
        current,
        speed,
        starter,
        models: [],
        small: null,
        medium: null,
        note: "Ollama isn't running, so Rocky can't see which models are installed.",
      });
    }
  });

  api.post("/models/use", async (c) => {
    const b = UseBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: z.prettifyError(b.error), code: "BAD_REQUEST" }, 400);
    const installed = await listLocalModels(rt.config.ollama.baseUrl);
    const names = new Set(installed.map((m) => m.name));
    for (const n of [b.data.small, b.data.medium])
      if (!names.has(n))
        return c.json({ error: `${n} is not installed in Ollama.`, code: "BAD_REQUEST" }, 400);
    updateUserYaml("policies", rt.dataDir, {
      models: {
        "local:small": `ollama/${b.data.small}`,
        "local:medium": `ollama/${b.data.medium}`,
      },
    });
    rt.reloadPolicy();
    return c.json({ saved: true, restartNeeded: false });
  });

  // First run (roadmap A1): download the starter model for this machine, with progress.
  api.post("/models/pull", (c) =>
    sse(c, errorBody, async (send) => {
      const r = await setupStarterModel({
        dataDir: rt.dataDir,
        baseUrl: rt.config.ollama.baseUrl,
        policy: loadPolicy(rt.dataDir),
        hardware: rt.hardware,
        onProgress: (p) => send({ type: "progress", ...p }),
      });
      rt.reloadPolicy();
      return r;
    }),
  );

  api.post("/models/bench", async (c) => {
    const model = strip(loadPolicy(rt.dataDir).models["local:medium"]);
    if (!model) return c.json({ error: "No local model is set.", code: "BAD_REQUEST" }, 400);
    const p = await benchModel(rt.config.ollama.baseUrl, model, rt.hardware);
    saveSpeedProfile(rt.dataDir, p);
    return c.json(p);
  });
}

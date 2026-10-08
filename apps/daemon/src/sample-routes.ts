import {
  loadSampleWorkspace,
  type Runtime,
  removeSampleWorkspace,
  SAMPLE_TOUR,
  sampleLoaded,
  suggestedQuestions,
} from "@rocky/core";
import type { Hono } from "hono";

/** Onboarding and Today (roadmap A9): the sample workspace and questions from your own data. */
export function registerSampleRoutes(
  api: Hono,
  { rt, poke }: { rt: Runtime; poke: () => void },
): void {
  api.get("/sample", (c) => c.json({ loaded: sampleLoaded(rt.db), tour: SAMPLE_TOUR }));
  api.post("/sample", async (c) => {
    const r = await loadSampleWorkspace(rt.db, rt.paths.blobs);
    poke(); // embed now rather than at the next poll
    return c.json(r, 201);
  });
  api.delete("/sample", (c) => c.json(removeSampleWorkspace(rt.db, rt.paths.blobs)));
  api.get("/suggestions", (c) => c.json({ questions: suggestedQuestions(rt.db) }));
}

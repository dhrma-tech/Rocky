import { z } from "zod";
import type { ActionRegistry } from "../src/actions/registry.ts";

/** Test action types: a GitHub-like issue type plus mail and calendar types (proposal tests). */
export function registerTestTypes(r: ActionRegistry, sink: unknown[]): void {
  r.register({
    type: "github.issueCreate",
    title: "Create GitHub issue",
    schema: z
      .object({ repo: z.string(), title: z.string().min(1), body: z.string().default("") })
      .strict(),
    risk: "medium",
    describe: (p) => ({ target: p.repo, summary: p.title }),
    execute: async (p) => {
      sink.push(p);
      return { ok: true };
    },
  });
  for (const type of ["gmail.draftCreate", "gcal.eventCreate"])
    r.register({
      type,
      title: type,
      schema: z.object({}).passthrough(),
      risk: "high",
      describe: () => ({ target: type, summary: type }),
      execute: async (p) => {
        sink.push(p);
        return {};
      },
    });
}

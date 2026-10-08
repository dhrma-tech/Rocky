import type { ActionRecord, Citation } from "@rocky/contracts";
import { z } from "zod";
import type { ActionService } from "../actions/service.ts";
import { type ActionDefinition, ActionError } from "../actions/types.ts";
import { asRefs, CHUNK_SELECT, citeRef, type RefChunk, refsPrompt } from "../notebooks/sources.ts";
import type { Router } from "../router/router.ts";
import { UNTRUSTED_RULE } from "../security/untrusted.ts";
import type { Db } from "../store/db.ts";
import { checkPath, rememberSourceFact } from "./profile.ts";

/**
 * Memory proposals (roadmap A5): a fact Rocky would like to remember waits in the approval queue
 * like any other change, shown as "Remember: …" with its quote. Approving saves it with its
 * provenance; the executor re-checks that the quote is still in the source.
 */

export const MEMORY_ADD = "memory.add";

const FILE = z.string().refine((f) => {
  try {
    checkPath(f);
    return true;
  } catch {
    return false;
  }
}, "a memory file path");

export const MemoryAddSchema = z
  .object({
    file: FILE,
    fact: z.string().trim().min(3).max(300),
    documentId: z.string().min(1),
    quote: z.string().trim().min(3).max(500),
  })
  .strict();
export type MemoryAdd = z.infer<typeof MemoryAddSchema>;

export function memoryAddAction(db: Db, dataDir: string): ActionDefinition<MemoryAdd> {
  return {
    type: MEMORY_ADD,
    title: "Remember",
    schema: MemoryAddSchema,
    risk: "low",
    actionClass: "write",
    describe: (p) => ({
      target: p.file,
      summary: p.fact,
      diff: { file: p.file, fact: p.fact, quote: p.quote },
    }),
    async execute(p, ctx) {
      const f = rememberSourceFact(db, dataDir, { ...p, run: ctx.idempotencyKey });
      return { file: f.path, facts: f.facts.length };
    },
  };
}

const SuggestOut = z.object({
  facts: z
    .array(
      z.object({
        file: z.string(),
        fact: z.string(),
        chunkRef: z.string(),
        quote: z.string(),
      }),
    )
    .max(12),
});

const SYSTEM = [
  "You suggest facts worth remembering about the user: their preferences, the people they work with, and their projects.",
  "Only facts the document states. Never guess, generalise or infer. Each fact copies a quote word for word from the block it comes from.",
  'Files: "about-you.md", "preferences.md", "people/<name>.md" or "projects/<name>.md" (lowercase, hyphens).',
  'Reply with JSON {"facts": [{"file", "fact", "chunkRef", "quote"}]}, at most 8. Reply {"facts": []} when nothing qualifies.',
  "",
  UNTRUSTED_RULE,
].join("\n");

export interface SuggestResult {
  proposed: ActionRecord[];
  dropped: { fact: string; reason: string }[];
}

/**
 * "Suggest memories from this" (user-triggered, so the origin is the user's turn). Each suggestion
 * must quote its block exactly or it is dropped; the rest land in the approval queue.
 */
export async function suggestMemories(
  deps: { db: Db; router: Router; actions: ActionService },
  documentId: string,
): Promise<SuggestResult> {
  const blocks: RefChunk[] = asRefs(
    deps.db
      .prepare(`${CHUNK_SELECT} where c.document_id = ? order by c.seq limit 40`)
      .all(documentId) as Omit<RefChunk, "ref">[],
  );
  if (!blocks.length) throw Object.assign(new Error("Document not found"), { code: "NOT_FOUND" });
  const doc = deps.db.prepare("select local_only from documents where id = ?").get(documentId) as
    | { local_only: number }
    | undefined;
  const run = await deps.router.run({
    task: "memory_suggest",
    origin: "user_turn",
    system: SYSTEM,
    prompt: `Document blocks:\n\n${refsPrompt(blocks)}`,
    schema: SuggestOut,
    scope: { localOnly: doc?.local_only === 1 },
  });
  const out: SuggestResult = { proposed: [], dropped: [] };
  for (const s of run.output.facts.slice(0, 8)) {
    const cite: Citation | null = citeRef(blocks, s.chunkRef, s.quote);
    if (!cite) {
      out.dropped.push({ fact: s.fact, reason: "its quote isn't in the document" });
      continue;
    }
    try {
      out.proposed.push(
        deps.actions.propose({
          type: MEMORY_ADD,
          payload: { file: s.file, fact: s.fact, documentId: cite.documentId, quote: s.quote },
          origin: "user_turn",
          citations: [cite],
          allowedTypes: [MEMORY_ADD],
        }),
      );
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      out.dropped.push({ fact: s.fact, reason: err.message });
    }
  }
  return out;
}

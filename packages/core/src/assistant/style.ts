import { type StyleOut, StyleOutSchema } from "@rocky/contracts";
import { ulid } from "ulid";
import { enqueue, type Job } from "../jobs/queue.ts";
import type { JobHandler } from "../jobs/runner.ts";
import type { Router } from "../router/router.ts";
import { UNTRUSTED_RULE, wrapUntrusted } from "../security/untrusted.ts";
import type { Db } from "../store/db.ts";
import { normalizeForQuote } from "./verified.ts";

/**
 * Style profile (assistant.md "Drafting in the user's voice"): a short descriptor of how the user
 * writes email plus up to 5 verbatim exemplars, learned from their own sent messages (local model
 * first). Exemplars must be copied from the samples; anything else is dropped. Refreshed monthly.
 */

export const STYLE_JOB = "style_profile";
const MAX_MESSAGES = 200;
/** Characters of samples in the prompt (fits the 16k local context with room for the reply). */
const PROMPT_CHARS = 12_000;
const MIN_MESSAGES = 5;
const REFRESH_MS = 30 * 86_400_000;

const SYSTEM = [
  "You describe how a person writes email, from samples of their own sent messages.",
  'Reply with JSON {"descriptor", "exemplars"}.',
  "descriptor: at most 120 words on greeting and sign-off habits, typical length, formality, tone and languages used.",
  "exemplars: up to 5 short passages copied word for word from the samples that show the style best.",
  "",
  UNTRUSTED_RULE,
].join("\n");

export interface StyleProfile {
  descriptor: string;
  exemplars: string[];
  updatedAt: number;
}

interface Sample {
  text: string;
  documentId: string;
}

/** The user's own sent messages (Gmail SENT label), newest first. */
export function sentSamples(db: Db, limit = MAX_MESSAGES): Sample[] {
  return (
    db
      .prepare(
        `select c.text, c.document_id as documentId from chunks c join documents d on d.id = c.document_id
         where d.source_type = 'email'
           and exists (select 1 from json_each(json_extract(d.meta, '$.sentMessageIds')) s
                       where s.value = json_extract(c.anchor, '$.messageId'))
         order by coalesce(d.updated_at, d.created_at) desc, c.seq limit ?`,
      )
      .all(limit) as Sample[]
  ).filter((s) => s.text.trim().length > 20);
}

export function getStyleProfile(db: Db): StyleProfile | null {
  const r = db
    .prepare(
      "select descriptor, exemplars, updated_at from style_profiles where channel = 'email' order by updated_at desc limit 1",
    )
    .get() as { descriptor: string; exemplars: string; updated_at: number } | undefined;
  return r
    ? {
        descriptor: r.descriptor,
        exemplars: JSON.parse(r.exemplars) as string[],
        updatedAt: r.updated_at,
      }
    : null;
}

export async function buildStyleProfile(
  deps: { db: Db; router: Router },
  now = Date.now(),
): Promise<StyleProfile> {
  const samples = sentSamples(deps.db);
  if (samples.length < MIN_MESSAGES)
    throw Object.assign(
      new Error(
        `Rocky needs at least ${MIN_MESSAGES} sent emails to learn your style; it found ${samples.length}.`,
      ),
      { code: "EMPTY" },
    );
  const used: Sample[] = [];
  let size = 0;
  for (const s of samples) {
    if (size + s.text.length > PROMPT_CHARS) break;
    used.push(s);
    size += s.text.length;
  }
  const localOnly = Boolean(
    (
      deps.db
        .prepare(
          `select 1 as x from documents where local_only = 1 and id in (${used.map(() => "?").join(",")}) limit 1`,
        )
        .get(...used.map((s) => s.documentId)) as { x: number } | undefined
    )?.x,
  );
  const run = await deps.router.run<StyleOut>({
    task: "style",
    origin: "system",
    system: SYSTEM,
    prompt: `Samples of the user's sent email:\n\n${used.map((s, i) => wrapUntrusted(s.text, { id: `s${i + 1}`, source: "sent mail" })).join("\n\n")}`,
    schema: StyleOutSchema,
    scope: { localOnly },
  });
  const corpus = used.map((s) => normalizeForQuote(s.text));
  const exemplars = run.output.exemplars
    .filter((e) => {
      const n = normalizeForQuote(e);
      return n.length >= 10 && corpus.some((t) => t.includes(n));
    })
    .slice(0, 5);
  const profile: StyleProfile = {
    descriptor: run.output.descriptor.trim(),
    exemplars,
    updatedAt: now,
  };
  deps.db.transaction(() => {
    deps.db.prepare("delete from style_profiles where channel = 'email'").run();
    deps.db
      .prepare(
        "insert into style_profiles (id, channel, descriptor, exemplars, updated_at, source_document_ids) values (?, 'email', ?, ?, ?, ?)",
      )
      .run(
        ulid(),
        profile.descriptor,
        JSON.stringify(exemplars),
        now,
        JSON.stringify([...new Set(used.map((s) => s.documentId))]),
      );
  })();
  return profile;
}

/**
 * Queues the monthly refresh. Only a profile the user built once (Drafts panel) is refreshed:
 * sent mail is never read in the background before they ask. `force` builds one now.
 */
export function queueStyleRefresh(
  db: Db,
  opts: { now?: number; heavy?: boolean; force?: boolean } = {},
): string | null {
  const now = opts.now ?? Date.now();
  const heavy = opts.heavy ?? true;
  const p = getStyleProfile(db);
  if (!opts.force && (!p || now - p.updatedAt < REFRESH_MS)) return null;
  const pending = db
    .prepare("select id from jobs where type = ? and status in ('queued', 'running')")
    .get(STYLE_JOB) as { id: string } | undefined;
  if (pending) return pending.id;
  if (sentSamples(db, MIN_MESSAGES).length < MIN_MESSAGES) return null;
  return enqueue(db, STYLE_JOB, {}, { heavy, priority: 5, maxAttempts: 1 });
}

export function styleJobHandler(deps: { db: Db; router: Router }): JobHandler {
  return async (_job: Job) => {
    await buildStyleProfile(deps);
  };
}

import fs from "node:fs";
import path from "node:path";
import type { AskResult, PathInfo, Usage } from "@rocky/contracts";
import YAML from "yaml";
import { z } from "zod";
import { ask, citedSourceTexts, normalizeForQuote } from "../assistant/ask.ts";
import { type RetrievedChunk, retrieve } from "../retrieval/retrieve.ts";
import type { Runtime } from "../runtime.ts";
import { UNTRUSTED_RULE, wrapUntrusted } from "../security/untrusted.ts";
import type { Db } from "../store/db.ts";

const GoldSchema = z.object({ file: z.string(), quote: z.string() });

export const EvalQuestionSchema = z.object({
  id: z.string(),
  bucket: z.string(),
  question: z.string(),
  answer: z.string().optional(),
  gold: z.array(GoldSchema).default([]),
  answerable: z.boolean().default(true),
});
export type EvalQuestion = z.infer<typeof EvalQuestionSchema>;

export const EvalSetSchema = z.object({ questions: z.array(EvalQuestionSchema).min(1) });

export function loadEvalSet(file: string): EvalQuestion[] {
  return EvalSetSchema.parse(YAML.parse(fs.readFileSync(file, "utf8"))).questions;
}

/** Phase 1 exit gates (PLAN §6). */
export const PHASE1_GATES = { hitAt5: 0.8, citationValidity: 0.9, abstention: 0.75 } as const;

const JudgeSchema = z.object({
  sentences: z.array(z.object({ i: z.number().int(), valid: z.boolean(), reason: z.string() })),
  correctness: z.enum(["correct", "partial", "incorrect"]),
});

const JUDGE_SYSTEM = `You grade answers produced by a retrieval system.

For each answer sentence, decide "valid": true only if the cited source text fully supports the sentence. Judge each sentence only against its own cited sources.
Then grade the whole answer against the reference answer: "correct" if it contains the reference's key facts and nothing contradicting them, "partial" if some key facts are missing, "incorrect" otherwise.

Reply with JSON: {"sentences":[{"i","valid","reason"}],"correctness":"correct"|"partial"|"incorrect"}.

${UNTRUSTED_RULE}`;

export interface QuestionResult {
  id: string;
  bucket: string;
  answerable: boolean;
  /** null for unanswerable questions. */
  hitAt5: boolean | null;
  notFound: boolean;
  /** Shown sentences and how many the judge found valid. */
  shown: number;
  valid: number;
  correctness: number | null;
  answer: string;
  path: PathInfo | null;
  judgeNotes: string[];
  error?: string;
}

export interface EvalReport {
  set: string;
  at: string;
  questions: number;
  hitAt5: number;
  citationValidity: number;
  abstention: { correct: number; total: number; rate: number };
  correctness: number;
  gates: Record<
    keyof typeof PHASE1_GATES,
    { value: number; min: number; skipped: boolean; pass: boolean }
  >;
  pass: boolean;
  usage: Usage;
  results: QuestionResult[];
}

/** Does any of the top-5 retrieved chunks come from the gold file and contain (the start of) a gold quote? */
function goldHit(db: Db, chunkIds: string[], gold: EvalQuestion["gold"]): boolean {
  if (chunkIds.length === 0 || gold.length === 0) return false;
  const rows = db
    .prepare(
      `select c.text, d.external_id from chunks c join documents d on d.id = c.document_id
       where c.id in (${chunkIds.map(() => "?").join(",")})`,
    )
    .all(...chunkIds) as { text: string; external_id: string | null }[];
  return gold.some((g) => {
    const q = normalizeForQuote(g.quote);
    // A quote split across a chunk boundary still counts if the chunk holds its first 6 words.
    const head = q.split(" ").slice(0, 6).join(" ");
    return rows.some(
      (r) =>
        path.basename(r.external_id ?? "") === g.file &&
        (normalizeForQuote(r.text).includes(q) || normalizeForQuote(r.text).includes(head)),
    );
  });
}

/**
 * What the judge sees for a citation: the same source window the quote check accepts (the
 * chunk plus text just around it), so a quote that straddles a chunk edge is judged fairly.
 */
function citedContext(db: Db, chunkId: string, quote: string): string {
  const c = db
    .prepare("select id, document_id, text, char_start, char_end from chunks where id = ?")
    .get(chunkId) as
    | { id: string; document_id: string; text: string; char_start: number; char_end: number }
    | undefined;
  if (!c) return "";
  const texts = citedSourceTexts(
    db,
    [
      {
        id: c.id,
        documentId: c.document_id,
        text: c.text,
        charStart: c.char_start,
        charEnd: c.char_end,
      } as RetrievedChunk,
    ],
    quote,
  );
  return texts[texts.length - 1] ?? c.text;
}

async function judge(
  rt: Runtime,
  q: EvalQuestion,
  r: AskResult,
  localOnly: boolean,
): Promise<{ out: z.infer<typeof JudgeSchema>; usage: Usage }> {
  const items = r.answer.map((s) => {
    const sources = s.citations
      .map((c) =>
        wrapUntrusted(citedContext(rt.db, c.chunkId, c.quote), { id: c.chunkId, source: c.title }),
      )
      .join("\n");
    return `Sentence ${s.i}: ${s.text}\nCited sources:\n${sources}`;
  });
  const prompt = `Question: ${q.question}\nReference answer: ${q.answer ?? "(none)"}\n\n${items.join("\n\n")}`;
  const res = await rt.router.run({
    task: "judge",
    origin: "system",
    system: JUDGE_SYSTEM,
    prompt,
    schema: JudgeSchema,
    scope: { localOnly },
    hints: { temperature: 0 },
  });
  return { out: res.output, usage: res.usage };
}

const add = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  costUsd: a.costUsd + b.costUsd,
});
const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);
const SCORE = { correct: 1, partial: 0.5, incorrect: 0 } as const;

/**
 * Runs an eval set against an already-ingested runtime: hit@5 from retrieval, then the full Ask
 * pipeline, then an LLM judge for citation validity and answer correctness (PLAN §6).
 */
export async function runEval(
  rt: Runtime,
  set: string,
  questions: EvalQuestion[],
  opts: { localOnly?: boolean; onProgress?: (r: QuestionResult, i: number) => void } = {},
): Promise<EvalReport> {
  const localOnly = Boolean(opts.localOnly);
  let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const results: QuestionResult[] = [];

  for (const [n, q] of questions.entries()) {
    const res: QuestionResult = {
      id: q.id,
      bucket: q.bucket,
      answerable: q.answerable,
      hitAt5: null,
      notFound: false,
      shown: 0,
      valid: 0,
      correctness: null,
      answer: "",
      path: null,
      judgeNotes: [],
    };
    try {
      if (q.answerable) {
        const top = await retrieve(rt.db, q.question, {
          embedder: rt.embedder,
          tokenBudget: Number.POSITIVE_INFINITY,
        });
        res.hitAt5 = goldHit(
          rt.db,
          top.slice(0, 5).map((c) => c.id),
          q.gold,
        );
      }
      const r = await ask(
        { db: rt.db, router: rt.router, embedder: rt.embedder },
        { question: q.question, scope: { localOnly } },
      );
      usage = add(usage, r.usage);
      res.notFound = r.notFound;
      res.path = r.path;
      res.answer = r.notFound
        ? "Not found in your sources."
        : r.answer.map((s) => s.text).join(" ");
      res.shown = r.answer.length;
      if (r.answer.length > 0) {
        const j = await judge(rt, q, r, localOnly);
        usage = add(usage, j.usage);
        const valid = new Map(j.out.sentences.map((s) => [s.i, s]));
        res.valid = r.answer.filter((s) => valid.get(s.i)?.valid).length;
        res.judgeNotes = j.out.sentences.filter((s) => !s.valid).map((s) => `#${s.i}: ${s.reason}`);
        if (q.answerable) res.correctness = SCORE[j.out.correctness];
      } else if (q.answerable) {
        res.correctness = 0;
      }
    } catch (err) {
      res.error = err instanceof Error ? err.message : String(err);
      if (q.answerable) res.correctness = 0;
    }
    results.push(res);
    opts.onProgress?.(res, n);
  }

  const answerable = results.filter((r) => r.answerable);
  const unanswerable = results.filter((r) => !r.answerable);
  const hitAt5 = ratio(answerable.filter((r) => r.hitAt5).length, answerable.length);
  const shown = results.reduce((s, r) => s + r.shown, 0);
  const citationValidity = ratio(
    results.reduce((s, r) => s + r.valid, 0),
    shown,
  );
  const abst = unanswerable.filter((r) => r.notFound && !r.error).length;
  const abstention = {
    correct: abst,
    total: unanswerable.length,
    rate: ratio(abst, unanswerable.length),
  };
  const correctness = ratio(
    answerable.reduce((s, r) => s + (r.correctness ?? 0), 0),
    answerable.length,
  );
  // A gate with nothing to measure (e.g. a --limit subset without unanswerable questions) is skipped.
  const gate = (value: number, min: number, n: number) => ({
    value,
    min,
    skipped: n === 0,
    pass: n === 0 || value >= min,
  });
  const gates = {
    hitAt5: gate(hitAt5, PHASE1_GATES.hitAt5, answerable.length),
    citationValidity: gate(citationValidity, PHASE1_GATES.citationValidity, shown),
    abstention: gate(abstention.rate, PHASE1_GATES.abstention, unanswerable.length),
  };
  return {
    set,
    at: new Date().toISOString(),
    questions: results.length,
    hitAt5,
    citationValidity,
    abstention,
    correctness,
    gates,
    pass: Object.values(gates).every((g) => g.pass),
    usage,
    results,
  };
}

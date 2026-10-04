import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EvalQuestion, runEval } from "../src/evals/run.ts";
import { ingestPath } from "../src/ingest/ingest-file.ts";
import { openRuntime, type Runtime } from "../src/runtime.ts";
import { memorySecrets } from "../src/secrets/keychain.ts";
import { fakeEmbedder, tempDir } from "./helpers.ts";
import { fakeProviders, HW_HIGH } from "./router-helpers.ts";

const DOCS = {
  "renewal.md":
    "# Vendor renewal\n\nThe CloudHost contract renews on November 1. Please give at least 30 days written notice to cancel.",
  "atlas.md":
    "# Project Atlas\n\nLena owns the data migration. We chose PostgreSQL because reporting needs relational joins.",
};

const QUESTIONS: EvalQuestion[] = [
  {
    id: "q1",
    bucket: "email",
    question: "How much notice do we need to cancel CloudHost?",
    answer: "30 days written notice.",
    gold: [{ file: "renewal.md", quote: "give at least 30 days written notice" }],
    answerable: true,
  },
  {
    id: "q2",
    bucket: "notion",
    question: "Who owns the data migration?",
    answer: "Lena.",
    gold: [{ file: "atlas.md", quote: "Lena owns the data migration" }],
    answerable: true,
  },
  {
    id: "na",
    bucket: "unanswerable",
    question: "What is the office Wi-Fi password?",
    gold: [],
    answerable: false,
  },
];

const sys = (body: Record<string, unknown>) => JSON.stringify(body);

/** Plays chat, verifier and judge from the request content; Ollama embeddings via the fake embedder. */
function world() {
  const emb = fakeEmbedder();
  const models = fakeProviders((_p, body) => {
    const s = sys(body);
    if (s.includes("You grade answers"))
      return { sentences: [{ i: 0, valid: true, reason: "ok" }], correctness: "correct" };
    if (s.includes("You check whether each claim"))
      return { labels: [{ i: 0, label: "SUPPORTED", reason: "ok" }] };
    // Answer with the gold quote of whichever question this is; chunk ids come from the prompt.
    const quote = QUESTIONS.find((q) => s.includes(`Question: ${q.question}`))?.gold[0]?.quote;
    if (!quote) return { sentences: [], notFound: true };
    const id = [...s.matchAll(/untrusted_data id=\\"([^\\]+)\\"[\s\S]*?<\/untrusted_data/g)].find(
      (m) => m[0].includes(quote),
    )?.[1];
    return { sentences: [{ text: quote, citations: [id], quote }], notFound: false };
  });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/embed")) {
      const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
      const vecs = await emb.embed(
        texts.map((t) => t.replace(/^search_(document|query): /, "")),
        "document",
      );
      return Response.json({ embeddings: vecs.map((v) => [...v]) });
    }
    return models.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls: models.calls };
}

let dir: string;
let rt: Runtime;
let calls: ReturnType<typeof world>["calls"];

beforeEach(async () => {
  dir = tempDir();
  const corpus = path.join(dir, "corpus");
  fs.mkdirSync(corpus);
  for (const [f, body] of Object.entries(DOCS)) fs.writeFileSync(path.join(corpus, f), body);
  const w = world();
  calls = w.calls;
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets({ anthropic: "sk-ant-test-key-123456" }),
    fetch: w.fetch,
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
  });
  await ingestPath(rt.db, rt.paths.blobs, corpus);
  expect(await rt.drainJobs()).toBe(2);
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runEval", () => {
  it("scores hit@5, citation validity, abstention and correctness, and passes the gates", async () => {
    const r = await runEval(rt, "test", QUESTIONS);
    expect(r.results.map((q) => [q.id, q.hitAt5, q.notFound, q.error])).toEqual([
      ["q1", true, false, undefined],
      ["q2", true, false, undefined],
      ["na", null, true, undefined],
    ]);
    expect(r.hitAt5).toBe(1);
    expect(r.citationValidity).toBe(1);
    expect(r.abstention).toEqual({ correct: 1, total: 1, rate: 1 });
    expect(r.correctness).toBe(1);
    expect(r.pass).toBe(true);
    expect(r.usage.costUsd).toBeGreaterThan(0);
    // chat + verify + judge for each answerable question, chat only for the abstention.
    expect(calls.filter((c) => !c.url.endsWith("/api/embed"))).toHaveLength(7);
  });

  it("fails the hit@5 gate when the gold quote is not in the corpus", async () => {
    const q = {
      ...QUESTIONS[0],
      gold: [{ file: "renewal.md", quote: "nowhere in the corpus" }],
    } as EvalQuestion;
    const r = await runEval(rt, "test", [q, QUESTIONS[2] as EvalQuestion]);
    expect(r.hitAt5).toBe(0);
    expect(r.gates.hitAt5.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("counts answering an unanswerable question as an abstention failure", async () => {
    const trap: EvalQuestion = { ...(QUESTIONS[1] as EvalQuestion), id: "trap", answerable: false };
    const r = await runEval(rt, "test", [trap]);
    expect(r.abstention).toEqual({ correct: 0, total: 1, rate: 0 });
    expect(r.gates.abstention.pass).toBe(false);
  });
});

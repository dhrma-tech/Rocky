import fs from "node:fs";
import type {
  Notebook,
  NotebookSource,
  QuizGrade,
  QuizQuestion,
  ReviewQueue,
} from "@rocky/contracts";
import { ingestPath, memorySecrets, openRuntime, type Runtime } from "@rocky/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEmbedder, tempDir } from "../../../packages/core/test/helpers.ts";
import { fakeProviders, HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";

const PORT = 7337;
const TOKEN = "t".repeat(64);
let dir: string;
let rt: Runtime;
let app: Hono;

/** Fake models keyed by system prompt, plus the embed endpoint. */
function fakeFetch() {
  const emb = fakeEmbedder();
  const ref = (s: string) => /<untrusted_data id=\\"(c\d+)\\"/.exec(s)?.[1] ?? "c1";
  const models = fakeProviders((_p, body) => {
    const s = JSON.stringify(body);
    if (s.includes("study flashcards"))
      return {
        cards: [
          {
            front: "What is a monad?",
            back: "A design pattern for chaining computations.",
            quote: "A monad is a design pattern",
            chunkRef: ref(s),
            topic: "Monads",
          },
        ],
      };
    if (s.includes("exam-style question"))
      return {
        question: "What is a monad?",
        options: null,
        referenceAnswer: "A design pattern for chaining computations.",
        quote: "A monad is a design pattern",
        chunkRef: ref(s),
        topic: "Monads",
        computations: [],
      };
    if (s.includes("You grade a student"))
      return {
        grade: 0.5,
        feedback: "Partly right.",
        citations: [{ chunkRef: ref(s), quote: "A monad is a design pattern" }],
        computations: [],
      };
    throw new Error("unexpected model call");
  });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/embed")) {
      const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ embeddings: (await emb.embed(texts, "document")).map((v) => [...v]) });
    }
    return models.fetch(input, init);
  }) as typeof fetch;
}

beforeEach(async () => {
  dir = tempDir();
  fs.mkdirSync(`${dir}/notes`);
  fs.writeFileSync(
    `${dir}/notes/FP101 monads.md`,
    "# Monads\n\nA monad is a design pattern for chaining computations with context, such as optional values or effects.",
  );
  fs.writeFileSync(
    `${dir}/notes/Groceries.md`,
    "# Groceries\n\nMilk, eggs and bread for the weekend.",
  );
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets({ anthropic: "sk-ant-test-key-123456" }),
    fetch: fakeFetch(),
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
  });
  await ingestPath(rt.db, rt.paths.blobs, `${dir}/notes`);
  await rt.drainJobs();
  app = createApp({ rt, auth: new Auth({ token: TOKEN, port: PORT }) });
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = async <T = unknown>(p: string, init: RequestInit = {}) => {
  const res = await app.request(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    ...init,
    headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    body: (text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text) as T,
    headers: res.headers,
  };
};
const send = <T = unknown>(method: string, p: string, body?: unknown) =>
  req<T>(p, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("notebooks API", () => {
  it("creates a course from a title rule, previews scope, edits sources", async () => {
    expect(
      (await send("POST", "/notebooks/scope/preview", { titleMatches: ["Monads"] })).body,
    ).toMatchObject({ count: 1 });
    const nb = await send<Notebook>("POST", "/notebooks", {
      name: "Functional programming",
      term: "Fall 2026",
      scope: { rules: { titleMatches: ["Monads"] } },
    });
    expect(nb.status).toBe(201);
    expect(nb.body).toMatchObject({ sourceCount: 1, localOnly: false, kind: "course" });
    const id = nb.body.id;
    const groceries = rt.db
      .prepare("select id from documents where title like 'Groceries%'")
      .get() as { id: string };
    await send("POST", `/notebooks/${id}/sources/${groceries.id}`);
    expect(
      (await req<{ sources: NotebookSource[] }>(`/notebooks/${id}/sources`)).body.sources
        .map((s) => s.addedBy)
        .sort(),
    ).toEqual(["manual", "rule"]);
    await send("DELETE", `/notebooks/${id}/sources/${groceries.id}`);
    expect(
      (await send<Notebook>("PATCH", `/notebooks/${id}`, { localOnly: true })).body,
    ).toMatchObject({ localOnly: true, sourceCount: 1 });
    expect((await send("POST", "/notebooks", { name: "" })).status).toBe(400);
    expect((await req("/notebooks/nope")).status).toBe(404);
  });

  it("generates cards in a job, reviews them, exports Anki, and runs a cited quiz", async () => {
    const id = (
      await send<Notebook>("POST", "/notebooks", {
        name: "FP",
        scope: { rules: { titleMatches: ["Monads"] } },
      })
    ).body.id;
    const job = await send<{ jobId: string }>("POST", `/notebooks/${id}/jobs/cards`);
    expect(job.status).toBe(202);
    expect((await send<{ jobId: string }>("POST", `/notebooks/${id}/jobs/cards`)).body.jobId).toBe(
      job.body.jobId,
    ); // deduped
    await rt.drainJobs();
    const q = await req<ReviewQueue>(`/study/review?notebook=${id}`);
    expect(q.body.cards).toHaveLength(1);
    const card = q.body.cards[0];
    expect(card?.citation?.quote).toBe("A monad is a design pattern");
    expect((await send("POST", `/cards/${card?.id}/review`, { rating: "good" })).status).toBe(200);
    expect((await send("POST", `/cards/${card?.id}/review`, { rating: "perfect" })).status).toBe(
      400,
    );
    const anki = await req(`/notebooks/${id}/export?format=anki`);
    expect(anki.text.split("\n").slice(0, 2)).toEqual(["#separator:Semicolon", "#html:false"]);
    expect(anki.headers.get("content-disposition")).toContain("FP-anki.txt");
    expect((await req(`/notebooks/${id}/export?format=md`)).status).toBe(404);

    const quiz = await send<{ id: string }>("POST", "/quizzes", {
      notebookId: id,
      topics: ["monads"],
    });
    const question = await send<QuizQuestion>("POST", `/quizzes/${quiz.body.id}/next`);
    expect(question.body).toMatchObject({ question: "What is a monad?", topic: "monads" });
    expect(question.text).not.toContain("chaining computations"); // the reference answer is hidden
    const grade = await send<QuizGrade>("POST", `/quizzes/${quiz.body.id}/answer`, {
      questionId: question.body.id,
      answer: "Some kind of box?",
    });
    expect(grade.body).toMatchObject({
      grade: 0.5,
      referenceAnswer: "A design pattern for chaining computations.",
    });
    expect(grade.body.citations[0]?.title).toMatch(/Monads/);
    expect(
      (await req<{ topics: { topic: string }[] }>(`/notebooks/${id}/countdown`)).body.topics[0]
        ?.topic,
    ).toBe("monads");
  });

  it("deletes a notebook with its study data but keeps documents", async () => {
    const id = (
      await send<Notebook>("POST", "/notebooks", {
        name: "FP",
        scope: { rules: { titleMatches: ["Monads"] } },
      })
    ).body.id;
    await send("POST", `/notebooks/${id}/jobs/cards`);
    await rt.drainJobs();
    await send("DELETE", `/notebooks/${id}`);
    expect((await req<{ notebooks: unknown[] }>("/notebooks")).body.notebooks).toEqual([]);
    expect(rt.db.prepare("select count(*) n from cards").get()).toEqual({ n: 0 });
    expect(rt.db.prepare("select count(*) n from documents").get()).toEqual({ n: 2 });
  });
});

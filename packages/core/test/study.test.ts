import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ankiCsv,
  ankiField,
  answerQuestion,
  buildMindMap,
  buildStudyGuide,
  countdown,
  createNotebook,
  createQuiz,
  type Db,
  generateCards,
  nextQuestion,
  notebookTopics,
  reviewCard,
  reviewQueue,
  studyGuideMarkdown,
  summarizeDocuments,
  validateMindMap,
  weaknessOf,
  workload,
} from "../src/index.ts";
import { embedDocument } from "../src/ingest/embed-job.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { evaluateComputations } from "../src/notebooks/math.ts";
import { fakeEmbedder, memoryDb } from "./helpers.ts";
import { fakeProviders, harness } from "./router-helpers.ts";

let db: Db;
let nb: string;
const embedder = fakeEmbedder();
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 6, 12);

const EIGEN =
  "# Eigenvalues\n\nAn eigenvector of a matrix A is a nonzero vector v such that A v equals lambda v. The scalar lambda is the eigenvalue. Eigenvalues are the roots of the characteristic polynomial det(A - lambda I).";
const DISCOUNT =
  "# Pricing exercise\n\nThe store gives a 17% discount on a 2,340 rupee order. Students should compute the discount amount and the final price.";

async function doc(
  id: string,
  title: string,
  body: string,
  sourceType: "markdown" | "meeting" = "markdown",
) {
  const { text, blocks } = markdownBlocks(body);
  const res = upsertDocument(db, {
    parsed: {
      title,
      sourceType,
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    externalId: id,
    createdAt: NOW - 3 * DAY,
  });
  await embedDocument(db, embedder, res.documentId);
  return res.documentId;
}
const chunk = (needle: string) =>
  (db.prepare("select id from chunks where text like ?").get(`%${needle}%`) as { id: string }).id;

/** Routes fake model replies by the task's system prompt. */
function models(replies: Record<string, (body: string) => unknown>) {
  return fakeProviders((_p, body) => {
    const s = JSON.stringify(body);
    for (const [needle, reply] of Object.entries(replies)) if (s.includes(needle)) return reply(s);
    throw new Error(`no fake reply for ${s.slice(0, 200)}`);
  });
}
const refOf = (body: string, needle: string) => {
  // Blocks look like <untrusted_data id="c2" …>…text…</untrusted_data>; find the block holding `needle`.
  const re = /<untrusted_data id=\\"(c\d+)\\"[^>]*>([\s\S]*?)<\/untrusted_data>/g;
  for (const m of body.matchAll(re)) if (m[2]?.includes(needle)) return m[1] as string;
  return "c1";
};

beforeEach(async () => {
  db = memoryDb();
  await doc("eig", "Lecture 6: eigenvalues", EIGEN, "meeting");
  await doc("disc", "Problem set 2", DISCOUNT);
  nb = createNotebook(db, { name: "Linear algebra", scope: { documentIds: [] } }).id;
  db.prepare(
    "insert into notebook_sources (notebook_id, document_id, added_by) select ?, id, 'manual' from documents",
  ).run(nb);
});
afterEach(() => db.close());

describe("flashcards", () => {
  it("keeps cards whose quote is in their chunk and drops the rest", async () => {
    const { fetch } = models({
      "study flashcards": (body) => ({
        cards: [
          {
            front: "What is an eigenvalue?",
            back: "The scalar lambda with A v = lambda v.",
            quote: "The scalar lambda is the eigenvalue",
            chunkRef: refOf(body, "eigenvector"),
            topic: "Eigenvalues",
          },
          {
            front: "Made up",
            back: "Not in the text.",
            quote: "matrices are always invertible",
            chunkRef: refOf(body, "eigenvector"),
            topic: "x",
          },
        ],
      }),
    });
    const r = await generateCards({ db, router: harness(db, fetch).router }, nb, { now: NOW });
    expect(r).toEqual({ created: 1, dropped: 1 });
    const q = reviewQueue(db, { notebookId: nb, now: NOW });
    expect(q.cards[0]).toMatchObject({
      front: "What is an eigenvalue?",
      isNew: true,
      topic: "eigenvalues",
    });
    expect(q.cards[0]?.citation?.quote).toBe("The scalar lambda is the eigenvalue");
  });

  it("schedules reviews with SM-2 and limits new cards per day", async () => {
    const ins = db.prepare(
      "insert into cards (id, notebook_id, front, back, topic, created_at) values (?, ?, ?, ?, 'eigenvalues', ?)",
    );
    for (let i = 0; i < 25; i++) ins.run(`k${i}`, nb, `Q${i}`, `A${i}`, NOW + i);
    let q = reviewQueue(db, { notebookId: nb, now: NOW });
    expect(q.cards).toHaveLength(20);
    const c = reviewCard(db, "k0", "good", NOW);
    expect(c).toMatchObject({ intervalDays: 1, repetitions: 1, isNew: false, dueAt: NOW + DAY });
    q = reviewQueue(db, { notebookId: nb, now: NOW });
    expect(q).toMatchObject({ newToday: 1, dueToday: 0 });
    expect(q.cards).toHaveLength(19);
    expect(reviewQueue(db, { notebookId: nb, now: NOW + DAY }).dueToday).toBe(1);
    expect(db.prepare("select rating, new_interval from card_reviews").get()).toEqual({
      rating: 4,
      new_interval: 1,
    });
  });

  it("exports Anki text with the documented headers and quoting (acceptance #5)", () => {
    db.prepare(
      "insert into cards (id, notebook_id, front, back, topic, created_at) values ('a', ?, 'What is λ?', 'Root of det(A - λI); see \"notes\"', 'eigen values', 1)",
    ).run(nb);
    db.prepare(
      "insert into cards (id, notebook_id, front, back, topic, created_at) values ('b', ?, 'Two;parts', 'line1\nline2', null, 2)",
    ).run(nb);
    expect(ankiCsv(db, nb)).toBe(
      [
        "#separator:Semicolon",
        "#html:false",
        "#notetype:Basic",
        "#deck:Rocky::Linear algebra",
        "#tags column:3",
        'What is λ?;"Root of det(A - λI); see ""notes""";rocky::Linear_algebra::eigen_values',
        '"Two;parts";"line1\nline2";rocky::Linear_algebra::general',
        "",
      ].join("\n"),
    );
    expect(ankiField("plain")).toBe("plain");
  });
});

describe("quiz with math routing (acceptance #3)", () => {
  // Warm the mathjs worker outside the test timeout (slow cold start under a parallel suite).
  beforeAll(() => evaluateComputations([{ id: "warm", expr: "1+1", purpose: "" }]), 60_000);

  it("computes 17% of 2,340 with mathjs, shows the expression, and never lets the model state it", async () => {
    const { fetch } = models({
      "exam-style question": (body) => ({
        question: "Compute 17% of 2,340.",
        options: null,
        referenceAnswer: "The discount is {{calc:d}} rupees.",
        quote: "17% discount on a 2,340 rupee order",
        chunkRef: refOf(body, "discount"),
        topic: "Percentages",
        computations: [{ id: "d", expr: "17/100*2340", purpose: "17% of 2,340" }],
      }),
      "You grade a student": (body) => ({
        grade: 1,
        feedback: "Correct: 17% of 2,340 is {{calc:g}}.",
        citations: [
          { chunkRef: refOf(body, "discount"), quote: "17% discount on a 2,340 rupee order" },
        ],
        computations: [{ id: "g", expr: "17% * 2340", purpose: "check" }],
      }),
    });
    const deps = { db, router: harness(db, fetch).router, embedder };
    const { id: quiz } = createQuiz(db, { notebookId: nb, topics: ["discount"] });
    const q = await nextQuestion(deps, quiz, NOW);
    expect(q).toEqual({
      id: q.id,
      quizId: quiz,
      question: "Compute 17% of 2,340.",
      options: null,
      topic: "percentages",
    });
    expect(JSON.stringify(q)).not.toContain("397.8"); // the reference stays hidden until grading
    const g = await answerQuestion(deps, quiz, q.id, "It's 397.8", NOW);
    expect(g.referenceAnswer).toBe("The discount is 397.8 rupees.");
    expect(g.feedback).toBe("Correct: 17% of 2,340 is 397.8.");
    expect(g.computations.map((c) => [c.expr, c.value])).toEqual([
      ["17/100*2340", "397.8"],
      ["17% * 2340", "397.8"],
    ]);
    expect(g.citations[0]).toMatchObject({ title: "Problem set 2", chunkId: chunk("discount") });
    expect(db.prepare("select grade, topic, notebook_id from quiz_attempts").get()).toEqual({
      grade: 1,
      topic: "percentages",
      notebook_id: nb,
    });
  });

  it("flags feedback where the grader wrote the computed number itself", async () => {
    const { fetch } = models({
      "exam-style question": (body) => ({
        question: "17% of 2,340?",
        options: null,
        referenceAnswer: "{{calc:d}}",
        quote: "17% discount on a 2,340 rupee order",
        chunkRef: refOf(body, "discount"),
        topic: "percentages",
        computations: [{ id: "d", expr: "17/100*2340", purpose: "" }],
      }),
      "You grade a student": () => ({
        grade: 0.5,
        feedback: "It is 397.8, see {{calc:g}}.",
        citations: [],
        computations: [{ id: "g", expr: "17/100*2340", purpose: "" }],
      }),
    });
    const deps = { db, router: harness(db, fetch).router, embedder };
    const { id: quiz } = createQuiz(db, { notebookId: nb });
    const q = await nextQuestion(deps, quiz, NOW);
    const g = await answerQuestion(deps, quiz, q.id, "400", NOW);
    expect(g.feedback).toMatch(/grader wrote a computed number itself/);
    expect(g.feedback).toMatch(/No source passage could be matched/);
  });
});

describe("weakness and countdown", () => {
  it("decays old attempts with a 7-day half-life; untested topics are 0.5", () => {
    expect(weaknessOf([], NOW)).toBe(0.5);
    expect(weaknessOf([{ grade: 0, at: NOW }], NOW)).toBe(1);
    // A failure two weeks ago weighs a quarter of a success today.
    expect(
      weaknessOf(
        [
          { grade: 0, at: NOW - 14 * DAY },
          { grade: 1, at: NOW },
        ],
        NOW,
      ),
    ).toBeCloseTo(0.25 / 1.25);
  });

  it("ranks weak topics and plans the day before the exam", () => {
    const { id: quiz } = createQuiz(db, { notebookId: nb });
    const ins = db.prepare(
      "insert into quiz_attempts (id, quiz_id, notebook_id, question, user_answer, grade, feedback, citations, topic, attempted_at) values (?, ?, ?, 'q', 'a', ?, '', '[]', ?, ?)",
    );
    ins.run("a1", quiz, nb, 0.2, "eigenvalues", NOW - DAY);
    ins.run("a2", quiz, nb, 0.9, "percentages", NOW - DAY);
    db.prepare("update notebooks set exam_dates = ? where id = ?").run(
      JSON.stringify([{ title: "Midterm", at: NOW + 3.5 * DAY }]),
      nb,
    );
    const c = countdown(db, nb, NOW);
    expect(c).toMatchObject({
      exam: { title: "Midterm" },
      daysLeft: 4,
      plan: { quizTopics: ["eigenvalues", "percentages"] },
    });
    expect(c.topics[0]?.topic).toBe("eigenvalues");
  });
});

describe("summaries, study guide, mind map, workload", () => {
  it("summarizes documents with topics and builds a cited guide from verified answers only", async () => {
    const { fetch } = models({
      "You summarise one course document": () => ({
        summary: "About eigenvalues.",
        topics: ["Eigenvalues", "Characteristic polynomial"],
      }),
      "You check whether each claim": () => ({
        labels: [
          { i: 0, label: "SUPPORTED", reason: "" },
          { i: 1, label: "UNSUPPORTED", reason: "" },
        ],
      }),
      "Explain eigenvalues": () => ({
        notFound: false,
        sentences: [
          {
            text: "An eigenvalue is the scalar lambda in A v = lambda v.",
            citations: [chunk("eigenvector")],
            quote: "The scalar lambda is the eigenvalue",
          },
          {
            text: "Every matrix is diagonalizable.",
            citations: [chunk("eigenvector")],
            quote: "Eigenvalues are the roots",
          },
        ],
      }),
      "Explain characteristic polynomial": () => ({ notFound: true, sentences: [] }),
    });
    const deps = { db, router: harness(db, fetch).router, embedder };
    // The short problem set (< 200 characters) isn't worth a summary.
    expect(await summarizeDocuments(deps, nb)).toEqual({ summarized: 1 });
    expect(notebookTopics(db, nb).slice(0, 2)).toEqual([
      "eigenvalues",
      "characteristic polynomial",
    ]);
    const guide = await buildStudyGuide(deps, nb, { now: NOW });
    expect(guide.sections).toEqual([
      {
        topic: "eigenvalues",
        sentences: [
          {
            text: "An eigenvalue is the scalar lambda in A v = lambda v.",
            citations: expect.any(Array),
          },
        ],
      },
    ]);
    const md = studyGuideMarkdown(guide);
    expect(md).toContain("## Eigenvalues");
    expect(md).toContain("An eigenvalue is the scalar lambda in A v = lambda v. [1]");
    expect(md).toContain('1. Lecture 6: eigenvalues: "The scalar lambda is the eigenvalue"');
  });

  it("mind map keeps only cited nodes and their edges", async () => {
    const { fetch } = models({
      "concept map": (body) => ({
        nodes: [
          { id: "n1", label: "Eigenvalue", chunkRefs: [refOf(body, "eigenvector")] },
          { id: "n2", label: "Hallucination", chunkRefs: ["c99"] },
          { id: "n3", label: "Discount", chunkRefs: [refOf(body, "discount")] },
        ],
        edges: [
          { from: "n1", to: "n2", label: null },
          { from: "n1", to: "n3", label: "unrelated" },
        ],
      }),
    });
    const m = await buildMindMap({ db, router: harness(db, fetch).router }, nb);
    expect(m.nodes.map((n) => n.id)).toEqual(["n1", "n3"]);
    expect(m.edges).toEqual([{ from: "n1", to: "n3", label: "unrelated" }]);
    expect(
      validateMindMap({ nodes: [], edges: [{ from: "a", to: "b", label: null }] }, []),
    ).toEqual({ nodes: [], edges: [] });
  });

  it("lists upcoming deadlines with the most related lectures", async () => {
    db.prepare("update notebooks set exam_dates = ? where id = ?").run(
      JSON.stringify([{ title: "Eigenvector eigenvalue lambda quiz", at: NOW + 2 * DAY }]),
      nb,
    );
    const items = await workload(db, nb, embedder, NOW);
    expect(items[0]).toMatchObject({ kind: "exam", title: "Eigenvector eigenvalue lambda quiz" });
    expect(items[0]?.related[0]?.title).toBe("Lecture 6: eigenvalues");
  });
});

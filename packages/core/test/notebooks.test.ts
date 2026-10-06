import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSource,
  ask,
  createNotebook,
  currentSlotNotebook,
  type Db,
  getNotebook,
  listNotebooks,
  materialize,
  notebookSources,
  previewScope,
  removeSource,
  retrieve,
  updateNotebook,
} from "../src/index.ts";
import { embedDocument } from "../src/ingest/embed-job.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { fakeEmbedder, memoryDb } from "./helpers.ts";
import { fakeProviders, harness } from "./router-helpers.ts";

let db: Db;
const embedder = fakeEmbedder();

async function doc(
  id: string,
  title: string,
  body: string,
  o: {
    connector?: string;
    sourceType?: "markdown" | "pdf" | "calendar" | "notion" | "meeting";
    meta?: Record<string, unknown>;
    createdAt?: number;
  } = {},
) {
  const { text, blocks } = markdownBlocks(body);
  const res = upsertDocument(db, {
    parsed: {
      title,
      sourceType: o.sourceType ?? "markdown",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    ...(o.connector ? { connectorId: o.connector } : {}),
    externalId: id,
    createdAt: o.createdAt ?? 1000,
    ...(o.meta ? { meta: o.meta } : {}),
  });
  await embedDocument(db, embedder, res.documentId);
  return res.documentId;
}

const titles = (nb: string) =>
  notebookSources(db, nb)
    .map((s) => s.title)
    .sort();

beforeEach(async () => {
  db = memoryDb();
  // Drive: a course folder with a subfolder.
  await doc("d1", "Week 1 slides", "Eigenvalues are scalars λ with A v = λ v.", {
    connector: "gdrive",
    sourceType: "pdf",
    meta: { ancestors: ["wk1", "cs201", "root"] },
  });
  await doc("d2", "Syllabus", "The midterm covers chapters one to five.", {
    connector: "gdrive",
    meta: { ancestors: ["cs201", "root"] },
  });
  await doc("d3", "Tax receipts", "Unrelated personal file.", {
    connector: "gdrive",
    meta: { ancestors: ["personal", "root"] },
  });
  // Notion: a page tree and a database row.
  await doc("n-root", "History notes", "Treaty of Versailles was signed in 1919.", {
    connector: "notion",
    sourceType: "notion",
  });
  await doc("n-child", "Causes of WWI", "Alliances and militarism were causes.", {
    connector: "notion",
    sourceType: "notion",
    meta: { parentId: "n-root" },
  });
  await doc("n-grand", "Archduke", "Franz Ferdinand was assassinated in 1914.", {
    connector: "notion",
    sourceType: "notion",
    meta: { parentId: "n-child" },
  });
  await doc("n-row", "Essay deadline", "Status: Planned", {
    connector: "notion",
    sourceType: "notion",
    meta: { dataSourceId: "ds-hist" },
  });
  await doc("n-other", "Recipes", "Pancakes need flour.", {
    connector: "notion",
    sourceType: "notion",
  });
  // Recorded lectures and a calendar exam.
  await doc("m1", "CS201 lecture 3", "Today we cover diagonalization of matrices.", {
    sourceType: "meeting",
    createdAt: 5000,
  });
  await doc("m2", "Gym", "Leg day.", { sourceType: "meeting", createdAt: 6000 });
  await doc("e1", "CS201 midterm exam", "When: 2099-11-03", {
    connector: "gcal",
    sourceType: "calendar",
    meta: { start: "2099-11-03T09:00:00Z" },
  });
});
afterEach(() => db.close());

describe("notebook scope rules", () => {
  it("matches Drive folders recursively, title codes, and keeps manual adds", async () => {
    const nb = createNotebook(db, {
      name: "Linear algebra",
      scope: { rules: { driveFolderIds: ["cs201"], titleMatches: ["CS201"] } },
    });
    expect(titles(nb.id)).toEqual([
      "CS201 lecture 3",
      "CS201 midterm exam",
      "Syllabus",
      "Week 1 slides",
    ]);
    const gym = db.prepare("select id from documents where title = 'Gym'").get() as { id: string };
    addSource(db, nb.id, gym.id);
    materialize(db, nb.id);
    expect(titles(nb.id)).toContain("Gym");
  });

  it("matches Notion pages with descendants and data-source rows", () => {
    const nb = createNotebook(db, {
      name: "History",
      scope: { rules: { notionPageIds: ["n-root", "ds-hist"] } },
    });
    expect(titles(nb.id)).toEqual(["Archduke", "Causes of WWI", "Essay deadline", "History notes"]);
  });

  it("filters by source type and date, and a manual removal sticks across re-materialization", () => {
    const nb = createNotebook(db, {
      name: "Lectures",
      scope: { rules: { sourceTypes: ["meeting"], dateFrom: 4000 } },
    });
    expect(titles(nb.id)).toEqual(["CS201 lecture 3", "Gym"]);
    const gym = notebookSources(db, nb.id).find((s) => s.title === "Gym")?.documentId as string;
    removeSource(db, nb.id, gym);
    materialize(db, nb.id);
    expect(titles(nb.id)).toEqual(["CS201 lecture 3"]);
    expect(previewScope(db, { sourceTypes: ["meeting"] }).count).toBe(2);
  });

  it("finds exam dates from tagged calendar events and lists counts", () => {
    const nb = createNotebook(db, {
      name: "Linear algebra",
      scope: { rules: { titleMatches: ["CS201"] } },
    });
    expect(getNotebook(db, nb.id).nextExam).toMatchObject({ title: "CS201 midterm exam" });
    updateNotebook(db, nb.id, { examDates: [{ title: "Quiz 2", at: Date.UTC(2099, 11, 1) }] });
    expect(getNotebook(db, nb.id).nextExam).toMatchObject({ title: "CS201 midterm exam" });
    expect(listNotebooks(db).map((n) => n.sourceCount)).toEqual([2]);
  });

  it("picks the notebook whose class slot is now for recording", () => {
    const tue = new Date(2026, 9, 6, 9, 55); // a Tuesday, 09:55 local
    createNotebook(db, {
      name: "Linear algebra",
      captureDefault: true,
      schedule: [{ day: 2, start: "10:00", end: "11:30" }],
    });
    expect(currentSlotNotebook(db, tue)?.name).toBe("Linear algebra"); // 5 min early counts
    expect(currentSlotNotebook(db, new Date(2026, 9, 6, 12, 0))).toBeNull();
  });
});

describe("scoped and cross-notebook retrieval (acceptance #1)", () => {
  it("a notebook question only sees its sources; a union sees both", async () => {
    const la = createNotebook(db, {
      name: "Linear algebra",
      scope: { rules: { driveFolderIds: ["cs201"], titleMatches: ["CS201"] } },
    });
    const hist = createNotebook(db, {
      name: "History",
      scope: { rules: { notionPageIds: ["n-root"] } },
    });
    const docsOf = async (q: string, notebookIds: string[]) =>
      new Set((await retrieve(db, q, { scope: { notebookIds }, embedder })).map((c) => c.title));
    const one = await docsOf("eigenvalues treaty 1919", [la.id]);
    expect(
      [...one].every((t) =>
        ["Week 1 slides", "Syllabus", "CS201 lecture 3", "CS201 midterm exam"].includes(t),
      ),
    ).toBe(true);
    const both = await docsOf("eigenvalues treaty 1919", [la.id, hist.id]);
    expect(both.has("Week 1 slides")).toBe(true);
    expect(both.has("History notes")).toBe(true);
    expect(both.has("Recipes")).toBe(false);
  });
});

describe("per-notebook local-only (acceptance #4, routing)", () => {
  it("routes a notebook question locally, and a union with a local-only notebook too", async () => {
    const la = createNotebook(db, {
      name: "Linear algebra",
      scope: { rules: { driveFolderIds: ["cs201"] } },
    });
    const hist = createNotebook(db, {
      name: "History",
      localOnly: true,
      scope: { rules: { notionPageIds: ["n-root"] } },
    });
    const { fetch, calls } = fakeProviders(() => ({ sentences: [], notFound: true }));
    const h = harness(db, fetch);
    await ask(
      { db, router: h.router, embedder },
      { question: "What are eigenvalues?", scope: { notebookIds: [la.id] } },
    );
    expect(calls.some((c) => c.url.includes("anthropic"))).toBe(true);
    calls.length = 0;
    await ask(
      { db, router: h.router, embedder },
      { question: "What are eigenvalues?", scope: { notebookIds: [la.id, hist.id] } },
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url.includes("127.0.0.1"))).toBe(true);
  });
});

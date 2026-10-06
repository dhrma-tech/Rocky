import {
  type Citation,
  type DocSummaryOut,
  DocSummaryOutSchema,
  type MindMap,
  type MindMapOut,
  MindMapOutSchema,
  type StudyGuide,
} from "@rocky/contracts";
import { ulid } from "ulid";
import { ask } from "../assistant/ask.ts";
import { UNTRUSTED_RULE, wrapUntrusted } from "../security/untrusted.ts";
import { getRow } from "./service.ts";
import {
  asRefs,
  CHUNK_SELECT,
  notebookScope,
  type RefChunk,
  refsPrompt,
  type StudyDeps,
} from "./sources.ts";

/** Summary rollups, the cited study guide and the mind map (notebooks.md). */

const SUMMARY_CHARS = 16_000;
const MAX_GUIDE_TOPICS = 8;

export const DOC_SUMMARY_SYSTEM = [
  "You summarise one course document for a student.",
  "summary: at most 150 words of plain prose, only from the text. topics: up to 8 short topic names",
  "(2 to 4 words each) that this document teaches.",
  "",
  UNTRUSTED_RULE,
].join("\n");

/** Summarises notebook documents that have no summary yet (document level, with topics). */
export async function summarizeDocuments(
  deps: StudyDeps,
  notebookId: string,
  opts: { limit?: number; onProgress?: (done: number, total: number) => void; now?: number } = {},
): Promise<{ summarized: number }> {
  const { db } = deps;
  const docs = db
    .prepare(
      `select d.id, d.title, d.raw_text from documents d join notebook_sources ns on ns.document_id = d.id and ns.notebook_id = ?
       where not exists (select 1 from summaries s where s.document_id = d.id and s.level = 'document')
         and length(d.raw_text) > 200
       order by coalesce(d.created_at, d.ingested_at) limit ?`,
    )
    .all(notebookId, opts.limit ?? 40) as { id: string; title: string; raw_text: string }[];
  const scope = notebookScope(db, notebookId);
  let n = 0;
  for (const d of docs) {
    opts.onProgress?.(n, docs.length);
    const r = await deps.router.run<DocSummaryOut>({
      task: "doc_summary",
      origin: "user_turn",
      system: DOC_SUMMARY_SYSTEM,
      prompt: `Document "${d.title}":\n\n${wrapUntrusted(d.raw_text.slice(0, SUMMARY_CHARS), { id: "doc", source: "notebook" })}`,
      schema: DocSummaryOutSchema,
      scope,
      hints: { temperature: 0 },
    });
    const topics = [...new Set(r.output.topics.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    db.prepare(
      `insert into summaries (id, level, scope_key, document_id, text, topics, model, created_at)
       values (?, 'document', ?, ?, ?, ?, ?, ?)`,
    ).run(
      ulid(),
      d.id,
      d.id,
      r.output.summary,
      JSON.stringify(topics),
      r.path.model,
      opts.now ?? Date.now(),
    );
    n++;
  }
  opts.onProgress?.(docs.length, docs.length);
  return { summarized: n };
}

/** The notebook's topics, most covered first (from document summaries and card topics). */
export function notebookTopics(db: StudyDeps["db"], notebookId: string): string[] {
  const counts = new Map<string, number>();
  for (const r of db
    .prepare(
      `select s.topics from summaries s join notebook_sources ns on ns.document_id = s.document_id
       where ns.notebook_id = ? and s.level = 'document'`,
    )
    .all(notebookId) as { topics: string }[])
    for (const t of JSON.parse(r.topics) as string[]) counts.set(t, (counts.get(t) ?? 0) + 2);
  for (const r of db
    .prepare("select topic from cards where notebook_id = ? and topic is not null")
    .all(notebookId) as { topic: string }[])
    counts.set(r.topic, (counts.get(r.topic) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/**
 * Study guide: for each top topic, a scoped question through the verified Ask pipeline. Only
 * sentences that pass verification are kept, so every sentence in the guide is cited.
 */
export async function buildStudyGuide(
  deps: StudyDeps,
  notebookId: string,
  opts: { onProgress?: (done: number, total: number) => void; now?: number } = {},
): Promise<StudyGuide> {
  const { db } = deps;
  const nb = getRow(db, notebookId);
  const topics = notebookTopics(db, notebookId).slice(0, MAX_GUIDE_TOPICS);
  const sections: StudyGuide["sections"] = [];
  for (const [i, topic] of topics.entries()) {
    opts.onProgress?.(i, topics.length);
    const r = await ask(
      { db, router: deps.router, ...(deps.embedder ? { embedder: deps.embedder } : {}) },
      {
        question: `Explain ${topic}: the key ideas, definitions and how they connect, for revision.`,
        scope: { notebookIds: [notebookId] },
      },
    );
    const sentences = r.answer
      .filter((s) => s.status === "supported")
      .map((s) => ({ text: s.text, citations: s.citations }));
    if (sentences.length) sections.push({ topic, sentences });
  }
  opts.onProgress?.(topics.length, topics.length);
  const guide: StudyGuide = {
    notebookId,
    title: `${nb.name}: study guide`,
    sections,
    createdAt: opts.now ?? Date.now(),
  };
  db.prepare(
    "delete from summaries where notebook_id = ? and level = 'notebook' and scope_key = 'guide'",
  ).run(notebookId);
  db.prepare(
    `insert into summaries (id, level, scope_key, notebook_id, text, topics, model, created_at)
     values (?, 'notebook', 'guide', ?, ?, ?, 'ask', ?)`,
  ).run(
    ulid(),
    notebookId,
    JSON.stringify(guide),
    JSON.stringify(sections.map((s) => s.topic)),
    guide.createdAt,
  );
  return guide;
}

export function latestStudyGuide(db: StudyDeps["db"], notebookId: string): StudyGuide | null {
  const r = db
    .prepare(
      "select text from summaries where notebook_id = ? and level = 'notebook' and scope_key = 'guide' order by created_at desc limit 1",
    )
    .get(notebookId) as { text: string } | undefined;
  return r ? (JSON.parse(r.text) as StudyGuide) : null;
}

export const MINDMAP_SYSTEM = [
  "You build a concept map of a course from its sources.",
  "nodes: up to 40 concepts {id, label (≤ 6 words), chunkRefs: ids of the blocks that discuss it}.",
  'edges: {from, to, label: short relation like "is a", "causes", "part of", or null}.',
  "Every node must cite at least one block. Use only concepts present in the blocks.",
  "",
  UNTRUSTED_RULE,
].join("\n");

/** Mind map: nodes without an in-scope citation are dropped, and so are edges to them. */
export async function buildMindMap(deps: StudyDeps, notebookId: string): Promise<MindMap> {
  const { db } = deps;
  const rows = db
    .prepare(
      `${CHUNK_SELECT} join notebook_sources ns on ns.document_id = d.id and ns.notebook_id = ?
       where c.token_count >= 30 order by c.token_count desc limit 24`,
    )
    .all(notebookId) as Omit<RefChunk, "ref">[];
  if (!rows.length) return { nodes: [], edges: [] };
  const refs = asRefs(rows);
  const r = await deps.router.run<MindMapOut>({
    task: "mindmap",
    origin: "user_turn",
    system: MINDMAP_SYSTEM,
    prompt: `Build the concept map from these blocks:\n\n${refsPrompt(refs)}`,
    schema: MindMapOutSchema,
    scope: notebookScope(db, notebookId),
    hints: { temperature: 0 },
  });
  return validateMindMap(r.output, refs);
}

export function validateMindMap(out: MindMapOut, refs: RefChunk[]): MindMap {
  const byRef = new Map(refs.map((c) => [c.ref, c]));
  const nodes = out.nodes
    .slice(0, 60)
    .map((n) => ({
      id: n.id,
      label: n.label,
      citations: n.chunkRefs.flatMap((ref): Citation[] => {
        const c = byRef.get(ref.trim());
        if (!c) return [];
        return [
          {
            chunkId: c.id,
            documentId: c.documentId,
            title: c.title,
            anchor: JSON.parse(c.anchor || '{"kind":"text"}'),
            quote: c.text.slice(0, 160),
          },
        ];
      }),
    }))
    .filter((n) => n.citations.length > 0);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = out.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .map((e) => ({ from: e.from, to: e.to, label: e.label }));
  return { nodes, edges };
}

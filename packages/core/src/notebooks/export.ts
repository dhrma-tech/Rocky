import type { Citation, StudyGuide } from "@rocky/contracts";
import type { Db } from "../store/db.ts";
import { getRow } from "./service.ts";
import { citationForChunk } from "./sources.ts";

/**
 * Exports (notebooks.md). Anki text import, verified 2026-10-06 against
 * docs.ankiweb.net/importing/text-files.html (Anki 2.1.54+): `#key:value` header lines, a field
 * holding the separator, a quote or a newline is wrapped in double quotes with `"` doubled, and
 * tags in the tags column are space-separated.
 */

const ANKI_SAFE = /[^A-Za-z0-9_\-:]+/g;
const tag = (s: string) =>
  s.trim().replace(ANKI_SAFE, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "general";

export function ankiField(s: string): string {
  const v = s.replace(/\r\n?/g, "\n");
  return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function ankiCsv(db: Db, notebookId: string): string {
  const nb = getRow(db, notebookId);
  const cards = db
    .prepare(
      "select front, back, topic from cards where notebook_id = ? and suspended = 0 order by created_at",
    )
    .all(notebookId) as { front: string; back: string; topic: string | null }[];
  const deck = `Rocky::${nb.name.replace(/::/g, " ")}`;
  const lines = [
    "#separator:Semicolon",
    "#html:false",
    "#notetype:Basic",
    `#deck:${deck}`,
    "#tags column:3",
    ...cards.map((c) =>
      [
        ankiField(c.front),
        ankiField(c.back),
        `rocky::${tag(nb.name)}::${tag(c.topic ?? "general")}`,
      ].join(";"),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

/** The study guide as Markdown with numbered sources (PDF: the web view's print stylesheet). */
export function studyGuideMarkdown(guide: StudyGuide): string {
  const sources = new Map<string, number>();
  const n = (chunkId: string) => {
    if (!sources.has(chunkId)) sources.set(chunkId, sources.size + 1);
    return sources.get(chunkId) as number;
  };
  const titles = new Map<number, string>();
  const body = guide.sections.map((s) => {
    const text = s.sentences
      .map((x) => {
        const marks = x.citations.map((c) => {
          const i = n(c.chunkId);
          titles.set(i, `${c.title}: "${c.quote}"`);
          return `[${i}]`;
        });
        return `${x.text} ${marks.join("")}`.trim();
      })
      .join(" ");
    return `## ${s.topic[0]?.toUpperCase() ?? ""}${s.topic.slice(1)}\n\n${text}`;
  });
  const refs = [...titles.entries()].sort((a, b) => a[0] - b[0]).map(([i, t]) => `${i}. ${t}`);
  return [
    `# ${guide.title}`,
    "",
    `_Generated ${new Date(guide.createdAt).toISOString().slice(0, 10)} from your sources. Every sentence is cited and checked._`,
    "",
    ...body.flatMap((b) => [b, ""]),
    "## Sources",
    "",
    ...refs,
    "",
  ].join("\n");
}

// --- Drive source pack (notebooks.md "Exports") ---

const DAY = 86_400_000;

/** ISO 8601 week ("2026-W42") and its Monday 00:00 / next Monday in local time. */
export function isoWeek(at: number): { week: string; start: number; end: number } {
  const d = new Date(at);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  const n = Math.floor((thursday.getTime() - jan1.getTime()) / DAY / 7) + 1;
  const next = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
  return {
    week: `${thursday.getFullYear()}-W${String(n).padStart(2, "0")}`,
    start: monday.getTime(),
    end: next.getTime(),
  };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const EXCERPT = 1500;

export interface SourcePackDraft {
  payload: { course: string; week: string; title: string; html: string };
  /** One per included document (its first chunk), so the proposal cites what it packs. */
  citations: Citation[];
  documents: number;
}

/**
 * One week of a course as HTML for a Google Doc: lecture summaries, transcript and document
 * excerpts, with links back to each source. Text is escaped: sources are untrusted.
 */
export function sourcePack(db: Db, notebookId: string, at = Date.now()): SourcePackDraft {
  const nb = getRow(db, notebookId);
  const { week, start, end } = isoWeek(at);
  const docs = db
    .prepare(
      `select d.id, d.title, d.uri, d.source_type, d.raw_text,
              coalesce(d.created_at, d.ingested_at) as at,
              (select s.text from summaries s where s.document_id = d.id and s.level = 'document'
               order by s.created_at desc limit 1) as summary,
              (select c.id from chunks c where c.document_id = d.id order by c.seq limit 1) as chunk_id
       from documents d join notebook_sources ns on ns.document_id = d.id and ns.notebook_id = ?
       where coalesce(d.created_at, d.ingested_at) >= ? and coalesce(d.created_at, d.ingested_at) < ?
       order by at`,
    )
    .all(notebookId, start, end) as {
    id: string;
    title: string;
    uri: string | null;
    source_type: string;
    raw_text: string;
    at: number;
    summary: string | null;
    chunk_id: string | null;
  }[];
  const title = `${nb.name}: ${week}`;
  const parts = [
    `<h1>${esc(title)}</h1>`,
    `<p>Source pack from Rocky. Every section links to its original.</p>`,
  ];
  const citations: Citation[] = [];
  for (const d of docs) {
    const when = new Date(d.at).toLocaleDateString("en-CA");
    const lecture = d.source_type === "transcript" || d.source_type === "meeting";
    parts.push(`<h2>${esc(d.title)}</h2>`, `<p><i>${esc(d.source_type)} · ${when}</i></p>`);
    if (d.uri) parts.push(`<p><a href="${esc(d.uri)}">Open the original</a></p>`);
    if (d.summary) parts.push("<h3>Summary</h3>", `<p>${esc(d.summary)}</p>`);
    const excerpt = d.raw_text.slice(0, EXCERPT).trim();
    if (excerpt)
      parts.push(
        `<h3>${lecture ? "Transcript excerpt" : "Excerpt"}</h3>`,
        ...excerpt.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`),
      );
    if (d.chunk_id) {
      const quote = excerpt.split(/\s+/).slice(0, 12).join(" ");
      const c = citationForChunk(db, d.chunk_id, quote);
      if (c) citations.push(c);
    }
  }
  if (!docs.length) parts.push("<p>No sources were added to this notebook this week.</p>");
  return {
    payload: { course: nb.name, week, title, html: parts.join("\n") },
    citations,
    documents: docs.length,
  };
}

import type { StudyGuide } from "@rocky/contracts";
import type { Db } from "../store/db.ts";
import { getRow } from "./service.ts";

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

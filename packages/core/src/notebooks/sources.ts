import { AnchorSchema, type Citation } from "@rocky/contracts";
import type { Embedder } from "../router/embed.ts";
import type { Router } from "../router/router.ts";
import { wrapUntrusted } from "../security/untrusted.ts";
import type { Db } from "../store/db.ts";
import { quoteInText } from "../text/quote.ts";
import { anyLocalOnly } from "./scope.ts";

/** Shared plumbing for study features: notebook chunks as short refs ("c1"), prompts, citations. */

export interface StudyDeps {
  db: Db;
  router: Router;
  embedder?: Embedder;
}

export interface RefChunk {
  ref: string;
  id: string;
  documentId: string;
  title: string;
  text: string;
  anchor: string;
}

export function asRefs(rows: Omit<RefChunk, "ref">[]): RefChunk[] {
  return rows.map((r, i) => ({ ...r, ref: `c${i + 1}` }));
}

/** Chunks as untrusted, labelled blocks the model cites by ref. */
export function refsPrompt(chunks: RefChunk[]): string {
  return chunks
    .map((c) => wrapUntrusted(c.text, { id: c.ref, source: "notebook", title: c.title }))
    .join("\n\n");
}

/** A citation for a ref, if the quote really is in that chunk. */
export function citeRef(chunks: RefChunk[], ref: string, quote: string): Citation | null {
  const c = chunks.find((x) => x.ref === ref.trim().replace(/^\[|\]$/g, ""));
  if (!c || !quoteInText(quote, c.text)) return null;
  const anchor = AnchorSchema.safeParse(JSON.parse(c.anchor || "{}"));
  return {
    chunkId: c.id,
    documentId: c.documentId,
    title: c.title,
    anchor: anchor.success ? anchor.data : { kind: "text" },
    quote: quote.trim(),
  };
}

export function citationForChunk(db: Db, chunkId: string, quote: string): Citation | null {
  const r = db
    .prepare(
      "select c.id, c.document_id, c.anchor, d.title from chunks c join documents d on d.id = c.document_id where c.id = ?",
    )
    .get(chunkId) as { id: string; document_id: string; anchor: string; title: string } | undefined;
  if (!r) return null;
  const anchor = AnchorSchema.safeParse(JSON.parse(r.anchor || "{}"));
  return {
    chunkId: r.id,
    documentId: r.document_id,
    title: r.title,
    anchor: anchor.success ? anchor.data : { kind: "text" },
    quote,
  };
}

/** Routing scope for a notebook: a local-only notebook keeps every model call local. */
export function notebookScope(
  db: Db,
  notebookId: string,
): { localOnly: boolean; notebookId: string } {
  return { localOnly: anyLocalOnly(db, [notebookId]), notebookId };
}

export const CHUNK_SELECT = `select c.id, c.document_id as documentId, d.title, c.text, c.anchor
  from chunks c join documents d on d.id = c.document_id`;

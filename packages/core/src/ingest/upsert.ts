import type { SourceType } from "@rocky/contracts";
import { ulid } from "ulid";
import { sha256 } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";
import { type ChunkDraft, chunkDocument } from "./chunker.ts";
import type { ParsedDoc } from "./types.ts";

/** Local files have no connector; they use this pseudo connector id so UNIQUE(connector_id, external_id) dedupes. */
export const LOCAL_CONNECTOR = "local-files";

export interface UpsertInput {
  parsed: ParsedDoc;
  connectorId?: string;
  externalId: string;
  uri?: string;
  mime?: string;
  blobHash?: string;
  createdAt?: number;
  updatedAt?: number;
  meta?: Record<string, unknown>;
  now?: number;
}

export interface UpsertResult {
  status: "created" | "updated" | "unchanged";
  documentId: string;
  chunks: number;
}

/** Deletes a document's FTS and vec rows. Neither virtual table cascades from `chunks`. */
export function deleteChunkIndexes(db: Db, documentId: string): void {
  const seqs = db.prepare("select seq from chunks where document_id = ?").all(documentId) as {
    seq: number;
  }[];
  const delFts = db.prepare("delete from chunks_fts where rowid = ?");
  const delVec = db.prepare("delete from chunks_vec where chunk_seq = ?");
  for (const { seq } of seqs) {
    delFts.run(seq);
    delVec.run(BigInt(seq));
  }
}

function insertChunks(db: Db, documentId: string, title: string, drafts: ChunkDraft[]): void {
  const ins = db.prepare(
    `insert into chunks (id, document_id, ord, text, token_count, char_start, char_end, anchor, section_path)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const fts = db.prepare("insert into chunks_fts (rowid, text, title) values (?, ?, ?)");
  for (const c of drafts) {
    const { lastInsertRowid } = ins.run(
      ulid(),
      documentId,
      c.ord,
      c.text,
      c.tokenCount,
      c.charStart,
      c.charEnd,
      JSON.stringify(c.anchor),
      c.sectionPath || null,
    );
    fts.run(lastInsertRowid, c.text, title);
  }
}

/**
 * Inserts or refreshes a document and its chunks in one transaction (memory.md "Upsert").
 * Unchanged content is skipped; changed content drops old chunks and their index rows.
 * Embedding is left to the caller (a queued job), since it needs the network to Ollama.
 */
export function upsertDocument(db: Db, input: UpsertInput): UpsertResult {
  const now = input.now ?? Date.now();
  const { parsed } = input;
  const connectorId = input.connectorId ?? LOCAL_CONNECTOR;
  const contentHash = sha256(`${parsed.title}\u0000${parsed.text}`);
  const sourceType: SourceType = parsed.sourceType;

  return db.transaction((): UpsertResult => {
    const existing = db
      .prepare("select id, content_hash from documents where connector_id = ? and external_id = ?")
      .get(connectorId, input.externalId) as { id: string; content_hash: string } | undefined;
    if (existing && existing.content_hash === contentHash) {
      return { status: "unchanged", documentId: existing.id, chunks: 0 };
    }

    const drafts = chunkDocument(parsed);
    const meta = JSON.stringify({ ...(parsed.meta ?? {}), ...(input.meta ?? {}) });
    let documentId: string;
    if (existing) {
      documentId = existing.id;
      deleteChunkIndexes(db, documentId);
      db.prepare("delete from chunks where document_id = ?").run(documentId);
      db.prepare(
        `update documents set source_type = ?, mime = ?, uri = ?, title = ?, updated_at = ?, ingested_at = ?,
         raw_text = ?, content_hash = ?, meta = ?, blob_hash = ? where id = ?`,
      ).run(
        sourceType,
        input.mime ?? null,
        input.uri ?? null,
        parsed.title,
        input.updatedAt ?? now,
        now,
        parsed.text,
        contentHash,
        meta,
        input.blobHash ?? null,
        documentId,
      );
    } else {
      documentId = ulid(now);
      db.prepare(
        `insert into documents (id, connector_id, external_id, source_type, mime, uri, title, created_at, updated_at,
         ingested_at, raw_text, content_hash, meta, blob_hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        documentId,
        connectorId,
        input.externalId,
        sourceType,
        input.mime ?? null,
        input.uri ?? null,
        parsed.title,
        input.createdAt ?? now,
        input.updatedAt ?? now,
        now,
        parsed.text,
        contentHash,
        meta,
        input.blobHash ?? null,
      );
    }
    insertChunks(db, documentId, parsed.title, drafts);
    return { status: existing ? "updated" : "created", documentId, chunks: drafts.length };
  })();
}

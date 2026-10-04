import { appendAudit } from "../audit/append.ts";
import { removeBlob } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";
import { deleteChunkIndexes } from "./upsert.ts";

/**
 * Deletes a document and everything derived from it: FTS and vec rows (which don't cascade),
 * chunks and other rows via ON DELETE CASCADE, and its blob once no other document uses it.
 * The audit entry holds only the id.
 */
export function deleteDocument(db: Db, blobsDir: string, documentId: string): boolean {
  const doc = db.prepare("select blob_hash from documents where id = ?").get(documentId) as
    | { blob_hash: string | null }
    | undefined;
  if (!doc) return false;
  db.transaction(() => {
    deleteChunkIndexes(db, documentId);
    db.prepare("delete from documents where id = ?").run(documentId);
    appendAudit(db, { eventType: "document_deleted", actor: "user", meta: { documentId } });
  })();
  if (doc.blob_hash) {
    const shared = db.prepare("select 1 from documents where blob_hash = ?").get(doc.blob_hash);
    if (!shared) removeBlob(blobsDir, doc.blob_hash);
  }
  return true;
}

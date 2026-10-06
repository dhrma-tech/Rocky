import { deleteData } from "../deletion/service.ts";
import type { Db } from "../store/db.ts";

/** Deletes one document and everything derived from it (see deletion/service.ts). */
export function deleteDocument(
  db: Db,
  blobsDir: string,
  documentId: string,
  recDir?: string,
): boolean {
  return (
    deleteData(db, blobsDir, { documentIds: [documentId] }, recDir ? { recDir } : {}).documents > 0
  );
}

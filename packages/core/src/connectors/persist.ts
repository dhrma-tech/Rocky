import type { SourceDocument } from "@rocky/connector-sdk";
import { EMBED_JOB } from "../ingest/embed-job.ts";
import { upsertDocument } from "../ingest/upsert.ts";
import { enqueue } from "../jobs/queue.ts";
import { putBlob } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";
import { toParsedDoc } from "./to-parsed.ts";

export type PreparedDocument = { doc: SourceDocument } & Awaited<ReturnType<typeof toParsedDoc>>;

export interface PersistCounts {
  added: number;
  updated: number;
  unchanged: number;
}

/**
 * Fetches and parses documents outside any transaction (network, CPU). A document that fails is
 * reported through `onSkip` and left out, so one bad item never sinks the batch.
 */
export async function prepareSourceDocuments(
  docs: SourceDocument[],
  onSkip: (externalId: string, err: unknown) => void = () => {},
): Promise<PreparedDocument[]> {
  const prepared: PreparedDocument[] = [];
  for (const doc of docs) {
    try {
      prepared.push({ doc, ...(await toParsedDoc(doc)) });
    } catch (err) {
      onSkip(doc.externalId, err);
    }
  }
  return prepared;
}

/**
 * Upserts prepared documents under one connector id in a single transaction and queues embedding
 * for new or changed ones. Connector syncs and archive imports share it; unchanged content is
 * skipped, so replaying a batch or re-importing an archive is idempotent.
 */
export function persistSourceDocuments(
  db: Db,
  blobsDir: string,
  connectorId: string,
  prepared: PreparedDocument[],
): PersistCounts {
  const counts: PersistCounts = { added: 0, updated: 0, unchanged: 0 };
  db.transaction(() => {
    for (const p of prepared) {
      const blobHash = p.bytes ? putBlob(blobsDir, p.bytes) : undefined;
      const res = upsertDocument(db, {
        parsed: p.parsed,
        connectorId,
        externalId: p.doc.externalId,
        mime: p.doc.mime,
        createdAt: p.doc.createdAt,
        updatedAt: p.doc.updatedAt,
        ...(p.doc.uri ? { uri: p.doc.uri } : {}),
        ...(blobHash ? { blobHash } : {}),
        meta: { ...(p.doc.meta ?? {}), ...(p.doc.author ? { author: p.doc.author } : {}) },
      });
      counts[res.status === "created" ? "added" : res.status]++;
      if (res.status !== "unchanged")
        enqueue(db, EMBED_JOB, { documentId: res.documentId }, { priority: 1 });
    }
  })();
  return counts;
}

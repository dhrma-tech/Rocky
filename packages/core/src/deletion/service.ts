import fs from "node:fs";
import path from "node:path";
import { appendAudit } from "../audit/append.ts";
import { dataPaths } from "../config/paths.ts";
import { deleteChunkIndexes } from "../ingest/upsert.ts";
import { SECRET_NAMES, type SecretName, type SecretStore } from "../secrets/keychain.ts";
import { removeBlob } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";

export type DeletionTarget =
  | { documentIds: string[] }
  | { connectorId: string }
  | { notebookId: string; withSources?: boolean }
  | { meetingId: string };

export interface DeletionReport {
  documents: number;
  chunks: number;
  cards: number;
  summaries: number;
  auditPayloads: number;
  blobs: number;
  jobs: number;
  meetings: number;
  /** Auto-created (unconfirmed) people and orgs no longer mentioned anywhere. */
  entities: number;
  /** Sources kept because another notebook still uses them (notebook deletes only). */
  keptShared: number;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

function documentsFor(db: Db, target: DeletionTarget): { ids: string[]; keptShared: number } {
  if ("documentIds" in target) {
    const ids = [...new Set(target.documentIds)];
    if (ids.length === 0) return { ids, keptShared: 0 };
    const found = db
      .prepare(`select id from documents where id in (${marks(ids.length)})`)
      .all(...ids) as { id: string }[];
    return { ids: found.map((r) => r.id), keptShared: 0 };
  }
  if ("meetingId" in target) {
    const row = db.prepare("select document_id from meetings where id = ?").get(target.meetingId) as
      | { document_id: string }
      | undefined;
    return { ids: row ? [row.document_id] : [], keptShared: 0 };
  }
  if ("connectorId" in target) {
    const rows = db
      .prepare("select id from documents where connector_id = ?")
      .all(target.connectorId) as { id: string }[];
    return { ids: rows.map((r) => r.id), keptShared: 0 };
  }
  if (!target.withSources) return { ids: [], keptShared: 0 };
  // A source used by another notebook stays; deleting this notebook must not empty that one.
  const rows = db
    .prepare(
      `select ns.document_id as id,
              exists (select 1 from notebook_sources o where o.document_id = ns.document_id and o.notebook_id <> ?) as shared
       from notebook_sources ns where ns.notebook_id = ?`,
    )
    .all(target.notebookId, target.notebookId) as { id: string; shared: number }[];
  return {
    ids: rows.filter((r) => !r.shared).map((r) => r.id),
    keptShared: rows.filter((r) => r.shared).length,
  };
}

/**
 * DeletionService (memory.md "Deletion", SECURITY.md "Deletion is complete"): removes documents
 * and everything derived from them in one transaction (FTS and vec rows, chunks, cards,
 * summaries, entity links, commitments, decisions, notebook links, pending jobs, audit payloads),
 * then unreferenced blobs. Logs one `deleted` event holding only IDs and counts.
 */
export function deleteData(
  db: Db,
  blobsDir: string,
  target: DeletionTarget,
  opts: { recDir?: string } = {},
): DeletionReport {
  const { ids, keptShared } = documentsFor(db, target);
  const report: DeletionReport = {
    documents: ids.length,
    chunks: 0,
    cards: 0,
    summaries: 0,
    auditPayloads: 0,
    blobs: 0,
    jobs: 0,
    meetings: 0,
    entities: 0,
    keptShared,
  };
  let blobHashes: string[] = [];
  let meetingIds: string[] = [];

  db.transaction(() => {
    if (ids.length > 0) {
      const chunkIds = (
        db
          .prepare(`select id from chunks where document_id in (${marks(ids.length)})`)
          .all(...ids) as { id: string }[]
      ).map((r) => r.id);
      report.chunks = chunkIds.length;
      blobHashes = (
        db
          .prepare(
            `select distinct blob_hash from documents where blob_hash is not null and id in (${marks(ids.length)})`,
          )
          .all(...ids) as { blob_hash: string }[]
      ).map((r) => r.blob_hash);

      const meetings = db
        .prepare(`select id, audio_blob from meetings where document_id in (${marks(ids.length)})`)
        .all(...ids) as { id: string; audio_blob: string | null }[];
      meetingIds = meetings.map((m) => m.id);
      report.meetings = meetings.length;
      for (const m of meetings)
        if (m.audio_blob && !blobHashes.includes(m.audio_blob)) blobHashes.push(m.audio_blob);

      for (const id of ids) deleteChunkIndexes(db, id);
      if (chunkIds.length > 0) {
        // Cards and rollup summaries point at chunks without a foreign key.
        const inChunks = `(${marks(chunkIds.length)})`;
        report.cards = db
          .prepare(`delete from cards where source_chunk_id in ${inChunks}`)
          .run(...chunkIds).changes;
        report.summaries += db
          .prepare(
            `delete from summaries where exists (select 1 from json_each(summaries.child_chunk_ids) where value in ${inChunks})`,
          )
          .run(...chunkIds).changes;
      }
      report.jobs = db
        .prepare(
          `delete from jobs where json_extract(payload, '$.documentId') in (${marks(ids.length)})`,
        )
        .run(...ids).changes;
      if (meetingIds.length)
        report.jobs += db
          .prepare(
            `delete from jobs where json_extract(payload, '$.meetingId') in (${marks(meetingIds.length)})`,
          )
          .run(...meetingIds).changes;

      // Payload bodies about these documents go, unless another subject still references them.
      report.auditPayloads = db
        .prepare(
          `delete from audit_payloads where payload_hash in (
             select a.payload_hash from audit_log a
             where a.payload_hash is not null and a.subject_type = 'document' and a.subject_id in (${marks(ids.length)})
               and not exists (
                 select 1 from audit_log b where b.payload_hash = a.payload_hash
                   and not (b.subject_type = 'document' and b.subject_id in (${marks(ids.length)}))))`,
        )
        .run(...ids, ...ids).changes;

      const before = (db.prepare("select count(*) as n from summaries").get() as { n: number }).n;
      db.prepare(`delete from documents where id in (${marks(ids.length)})`).run(...ids);
      report.summaries +=
        before - (db.prepare("select count(*) as n from summaries").get() as { n: number }).n;

      // Entities Rocky created from this content (never confirmed by the user) and now unused.
      report.entities = db
        .prepare(
          `delete from entities where unconfirmed = 1
             and not exists (select 1 from document_entities de where de.entity_id = entities.id)
             and not exists (select 1 from commitments c where c.owner_entity_id = entities.id or c.counterparty_entity_id = entities.id)
             and not exists (select 1 from decisions d where d.owner_entity_id = entities.id)`,
        )
        .run().changes;
    }

    if ("notebookId" in target)
      db.prepare("delete from notebooks where id = ?").run(target.notebookId);
    if ("connectorId" in target)
      db.prepare("delete from connectors where id = ?").run(target.connectorId);

    appendAudit(db, {
      eventType: "deleted",
      actor: "user",
      meta: {
        target:
          "documentIds" in target
            ? "documents"
            : "meetingId" in target
              ? "meeting"
              : "connectorId" in target
                ? "connector"
                : "notebook",
        ...("connectorId" in target ? { connectorId: target.connectorId } : {}),
        ...("notebookId" in target ? { notebookId: target.notebookId } : {}),
        ...(meetingIds.length ? { meetingIds } : {}),
        documentIds: ids,
        counts: { ...report },
      },
    });
  })();

  // Blobs are files; remove them after the commit, and only if nothing else still uses them.
  const used = db.prepare(
    "select 1 from documents where blob_hash = ? union all select 1 from meetings where audio_blob = ? limit 1",
  );
  for (const h of blobHashes)
    if (!used.get(h, h)) {
      removeBlob(blobsDir, h);
      report.blobs++;
    }
  // In-progress recording chunks and whisper WAVs.
  if (opts.recDir)
    for (const id of meetingIds)
      fs.rmSync(path.join(opts.recDir, id), { recursive: true, force: true });
  return report;
}

/**
 * "Delete everything": the DB (with WAL and backups), blobs, eval databases and every Rocky
 * keychain entry. Settings files and downloaded models stay. The caller must close the DB first.
 */
export function deleteEverything(dataDir: string, secrets: SecretStore): { removed: string[] } {
  const p = dataPaths(dataDir);
  const targets = [
    p.db,
    `${p.db}-wal`,
    `${p.db}-shm`,
    p.backups,
    p.blobs,
    p.rec,
    `${p.root}/evals`,
    `${p.root}/daemon.json`,
  ];
  const removed: string[] = [];
  for (const t of targets)
    if (fs.existsSync(t)) {
      fs.rmSync(t, { recursive: true, force: true });
      removed.push(t);
    }
  // Connector secrets ("github.token", …) are listed from the keychain itself.
  for (const name of new Set<SecretName>([...SECRET_NAMES, ...(secrets.list() as SecretName[])]))
    if (secrets.has(name)) {
      secrets.delete(name);
      removed.push(`keychain:rocky/${name}`);
    }
  return { removed };
}

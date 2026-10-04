import { sha256 } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";

export const GENESIS_HASH = "0".repeat(64);

/** JSON with sorted object keys, so equal values always hash the same. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

export interface AuditEvent {
  eventType: string;
  actor: "user" | "routine" | "system";
  subjectType?: string;
  subjectId?: string;
  /** Stored in audit_payloads (purgeable); the chain covers only its hash (PLAN §3 #1). */
  payload?: unknown;
  /** IDs and metadata only. Never content. */
  meta?: Record<string, unknown>;
  at?: number;
}

export interface AuditRowHashInput {
  prev_hash: string;
  at: number;
  event_type: string;
  actor: string;
  subject_type: string | null;
  subject_id: string | null;
  payload_hash: string | null;
  meta: string;
}

export const rowHash = (r: AuditRowHashInput) =>
  sha256(
    r.prev_hash +
      canonical({
        at: r.at,
        event_type: r.event_type,
        actor: r.actor,
        subject_type: r.subject_type,
        subject_id: r.subject_id,
        payload_hash: r.payload_hash,
        meta: r.meta,
      }),
  );

/**
 * Appends one hash-chained audit row (SECURITY.md): row_hash = sha256(prev_hash ‖ canonical(row)).
 * The table's triggers reject UPDATE and DELETE. Verification (`rocky audit verify`) is Phase 2.
 */
export function appendAudit(db: Db, e: AuditEvent): { seq: number; rowHash: string } {
  return db.transaction(() => {
    const prev =
      (
        db.prepare("select row_hash from audit_log order by seq desc limit 1").get() as
          | { row_hash: string }
          | undefined
      )?.row_hash ?? GENESIS_HASH;
    let payloadHash: string | null = null;
    if (e.payload !== undefined) {
      const body = canonical(e.payload);
      payloadHash = sha256(body);
      db.prepare("insert or ignore into audit_payloads (payload_hash, body) values (?, ?)").run(
        payloadHash,
        body,
      );
    }
    const row: AuditRowHashInput = {
      prev_hash: prev,
      at: e.at ?? Date.now(),
      event_type: e.eventType,
      actor: e.actor,
      subject_type: e.subjectType ?? null,
      subject_id: e.subjectId ?? null,
      payload_hash: payloadHash,
      meta: canonical(e.meta ?? {}),
    };
    const h = rowHash(row);
    const { lastInsertRowid } = db
      .prepare(
        `insert into audit_log (at, event_type, actor, subject_type, subject_id, payload_hash, meta, prev_hash, row_hash)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.at,
        row.event_type,
        row.actor,
        row.subject_type,
        row.subject_id,
        row.payload_hash,
        row.meta,
        row.prev_hash,
        h,
      );
    return { seq: Number(lastInsertRowid), rowHash: h };
  })();
}

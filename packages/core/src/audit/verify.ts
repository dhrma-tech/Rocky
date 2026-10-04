import type { AuditVerify } from "@rocky/contracts";
import type { Db } from "../store/db.ts";
import { type AuditRowHashInput, GENESIS_HASH, rowHash } from "./append.ts";

/**
 * `rocky audit verify` (specs/actions.md): walks the log in seq order, checks each row links to
 * the previous row's hash and that its own hash recomputes. Reports the first broken seq.
 * Purged payloads don't break the chain: rows hold only the payload hash.
 */
export function verifyAuditChain(db: Db): AuditVerify {
  const rows = db
    .prepare(
      "select seq, at, event_type, actor, subject_type, subject_id, payload_hash, meta, prev_hash, row_hash from audit_log order by seq",
    )
    .iterate() as IterableIterator<AuditRowHashInput & { seq: number; row_hash: string }>;
  let prev = GENESIS_HASH;
  let checked = 0;
  for (const r of rows) {
    if (r.prev_hash !== prev)
      return {
        ok: false,
        checked,
        firstBrokenSeq: r.seq,
        reason: "prev_hash does not link to the previous row",
      };
    if (rowHash(r) !== r.row_hash)
      return {
        ok: false,
        checked,
        firstBrokenSeq: r.seq,
        reason: "row contents do not match row_hash",
      };
    prev = r.row_hash;
    checked++;
  }
  return { ok: true, checked };
}

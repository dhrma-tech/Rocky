import type { Scope } from "@rocky/contracts";
import type { Db } from "../store/db.ts";
import { scopeFilter } from "./scope.ts";

/**
 * KNN over chunks_vec. vec0 pre-filters on its metadata columns (single source type, date
 * range); the remaining scope is applied by joining afterwards, which is why narrow scopes
 * pass a larger k.
 */
export function searchVec(db: Db, query: Float32Array, scope: Scope | undefined, k = 50): number[] {
  const meta: string[] = [];
  const metaParams: unknown[] = [];
  if (scope?.sourceTypes?.length === 1) {
    meta.push("and source_type = ?");
    metaParams.push(scope.sourceTypes[0]);
  }
  if (scope?.dateFrom !== undefined) {
    meta.push("and created_at >= ?");
    metaParams.push(BigInt(scope.dateFrom));
  }
  if (scope?.dateTo !== undefined) {
    meta.push("and created_at <= ?");
    metaParams.push(BigInt(scope.dateTo));
  }
  const f = scopeFilter(scope);
  const rows = db
    .prepare(
      `with knn as (
         select chunk_seq, distance from chunks_vec
         where embedding match ? and k = ? ${meta.join(" ")}
       )
       select knn.chunk_seq as seq from knn
       join chunks c on c.seq = knn.chunk_seq
       join documents d on d.id = c.document_id
       ${f.where ? `where ${f.where}` : ""}
       order by knn.distance`,
    )
    .all(
      Buffer.from(query.buffer, query.byteOffset, query.byteLength),
      k,
      ...metaParams,
      ...f.params,
    ) as { seq: number | bigint }[];
  return rows.map((r) => Number(r.seq));
}

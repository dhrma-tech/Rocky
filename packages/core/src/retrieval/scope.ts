import type { Scope } from "@rocky/contracts";

export interface SqlFilter {
  /** Conditions on `documents d` (and `chunks c`), joined with AND. Empty means no filter. */
  where: string;
  params: unknown[];
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Translates a Scope into SQL over `documents d`. Notebooks match via notebook_sources. */
export function scopeFilter(scope: Scope | undefined): SqlFilter {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (!scope) return { where: "", params };
  if (scope.documentIds?.length) {
    conds.push(`d.id in (${placeholders(scope.documentIds.length)})`);
    params.push(...scope.documentIds);
  }
  if (scope.notebookIds?.length) {
    conds.push(
      `exists (select 1 from notebook_sources ns where ns.document_id = d.id and ns.notebook_id in (${placeholders(scope.notebookIds.length)}))`,
    );
    params.push(...scope.notebookIds);
  }
  if (scope.connectorIds?.length) {
    conds.push(`d.connector_id in (${placeholders(scope.connectorIds.length)})`);
    params.push(...scope.connectorIds);
  }
  if (scope.sourceTypes?.length) {
    conds.push(`d.source_type in (${placeholders(scope.sourceTypes.length)})`);
    params.push(...scope.sourceTypes);
  }
  if (scope.entityIds?.length) {
    conds.push(
      `exists (select 1 from document_entities de where de.document_id = d.id and de.entity_id in (${placeholders(scope.entityIds.length)}))`,
    );
    params.push(...scope.entityIds);
  }
  if (scope.dateFrom !== undefined) {
    conds.push("coalesce(d.created_at, d.ingested_at) >= ?");
    params.push(scope.dateFrom);
  }
  if (scope.dateTo !== undefined) {
    conds.push("coalesce(d.created_at, d.ingested_at) <= ?");
    params.push(scope.dateTo);
  }
  return { where: conds.join(" and "), params };
}

/** Narrow scopes oversample the vector side, since vec0 can only pre-filter on its metadata columns. */
export function isNarrow(scope: Scope | undefined): boolean {
  return Boolean(
    scope?.notebookIds?.length ||
      scope?.documentIds?.length ||
      scope?.entityIds?.length ||
      scope?.connectorIds?.length,
  );
}

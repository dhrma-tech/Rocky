import { NotebookScopeSchema, type ScopeRules } from "@rocky/contracts";
import type { Db } from "../store/db.ts";

/**
 * Notebook rules → `notebook_sources` (notebooks.md "Notebook = scope"). Materializing keeps
 * retrieval filtering a cheap join. Source rules (connectors, Drive folders, Notion pages, title
 * matches) are OR'ed; filters (source types, date range) narrow the result. Manual adds stay; a
 * manual removal is kept in `excludedIds` so a rule never brings the document back.
 */

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

function ruleSql(rules: ScopeRules): { sql: string; params: unknown[] } | null {
  const any: string[] = [];
  const params: unknown[] = [];
  if (rules.connectorIds?.length) {
    any.push(`d.connector_id in (${marks(rules.connectorIds.length)})`);
    params.push(...rules.connectorIds);
  }
  if (rules.driveFolderIds?.length) {
    any.push(
      `(d.connector_id = 'gdrive' and exists (select 1 from json_each(d.meta, '$.ancestors') a where a.value in (${marks(rules.driveFolderIds.length)})))`,
    );
    params.push(...rules.driveFolderIds);
  }
  if (rules.notionPageIds?.length) {
    // The page itself, every descendant through meta.parentId, and rows of a listed data source.
    const ids = rules.notionPageIds;
    any.push(`(d.connector_id = 'notion' and (d.external_id in (
        with recursive sub(id) as (
          select external_id from documents where connector_id = 'notion' and external_id in (${marks(ids.length)})
          union
          select c.external_id from documents c join sub on json_extract(c.meta, '$.parentId') = sub.id
          where c.connector_id = 'notion')
        select id from sub)
      or json_extract(d.meta, '$.dataSourceId') in (${marks(ids.length)})))`);
    params.push(...ids, ...ids);
  }
  for (const f of rules.localFolders ?? []) {
    // Local files are keyed by absolute path; compare case-insensitively (Windows paths are).
    const sep = f.includes("\\") ? "\\" : "/";
    const prefix = f.replace(/[\\/]+$/, "") + sep;
    any.push("(d.connector_id = 'local-files' and lower(substr(d.external_id, 1, ?)) = lower(?))");
    params.push(prefix.length, prefix);
  }
  for (const t of rules.titleMatches ?? []) {
    any.push("instr(lower(d.title), lower(?)) > 0");
    params.push(t);
  }
  const filters: string[] = [];
  if (rules.sourceTypes?.length) {
    filters.push(`d.source_type in (${marks(rules.sourceTypes.length)})`);
    params.push(...rules.sourceTypes);
  }
  if (rules.dateFrom !== undefined) {
    filters.push("coalesce(d.created_at, d.ingested_at) >= ?");
    params.push(rules.dateFrom);
  }
  if (rules.dateTo !== undefined) {
    filters.push("coalesce(d.created_at, d.ingested_at) <= ?");
    params.push(rules.dateTo);
  }
  if (!any.length && !filters.length) return null;
  const where = [any.length ? `(${any.join(" or ")})` : "", ...filters]
    .filter(Boolean)
    .join(" and ");
  return { sql: `select d.id from documents d where ${where}`, params };
}

/** Documents the rules select right now (scope preview and materialization). */
export function ruleDocuments(db: Db, rules: ScopeRules): string[] {
  const q = ruleSql(rules);
  if (!q) return [];
  return (db.prepare(q.sql).all(...q.params) as { id: string }[]).map((r) => r.id);
}

/** Re-evaluates one notebook's rules; returns how many rule sources it now has. */
export function materialize(db: Db, notebookId: string): number {
  const row = db.prepare("select scope from notebooks where id = ?").get(notebookId) as
    | { scope: string }
    | undefined;
  if (!row) return 0;
  const scope = NotebookScopeSchema.catch({ documentIds: [], excludedIds: [], rules: {} }).parse(
    JSON.parse(row.scope || "{}"),
  );
  const excluded = new Set(scope.excludedIds);
  const ids = ruleDocuments(db, scope.rules).filter((id) => !excluded.has(id));
  db.transaction(() => {
    db.prepare("create temp table if not exists _rule_ids (id text primary key)").run();
    db.prepare("delete from _rule_ids").run();
    const ins = db.prepare("insert or ignore into _rule_ids (id) values (?)");
    for (const id of ids) ins.run(id);
    db.prepare(
      "delete from notebook_sources where notebook_id = ? and added_by = 'rule' and document_id not in (select id from _rule_ids)",
    ).run(notebookId);
    db.prepare(
      `insert or ignore into notebook_sources (notebook_id, document_id, added_by)
       select ?, id, 'rule' from _rule_ids`,
    ).run(notebookId);
    for (const id of scope.documentIds)
      db.prepare(
        `insert into notebook_sources (notebook_id, document_id, added_by)
         select ?, ?, 'manual' where exists (select 1 from documents where id = ?)
         on conflict (notebook_id, document_id) do update set added_by = 'manual'`,
      ).run(notebookId, id, id);
    if (excluded.size)
      db.prepare(
        `delete from notebook_sources where notebook_id = ? and document_id in (${marks(excluded.size)})`,
      ).run(notebookId, ...excluded);
  })();
  return ids.length;
}

export function materializeAll(db: Db): void {
  for (const { id } of db.prepare("select id from notebooks").all() as { id: string }[])
    materialize(db, id);
}

/** True when any of these notebooks is local-only (a cross-notebook union is then local-only too). */
export function anyLocalOnly(db: Db, notebookIds: string[] | undefined): boolean {
  if (!notebookIds?.length) return false;
  return Boolean(
    db
      .prepare(
        `select 1 from notebooks where local_only = 1 and id in (${marks(notebookIds.length)}) limit 1`,
      )
      .get(...notebookIds),
  );
}

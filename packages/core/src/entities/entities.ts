import type { Entity, EntityKind } from "@rocky/contracts";
import { ulid } from "ulid";
import type { Db } from "../store/db.ts";

/** settings key holding the entity that stands for the user ("me", "I", the mic channel). */
export const USER_ENTITY_KEY = "user_entity_id";
const SELF = new Set(["me", "i", "myself", "you (me)", "the user"]);

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** Lowercase, accents stripped, punctuation collapsed: "José  O'Neil" → "jose o neil". Emails stay whole. */
export function normAlias(s: string): string {
  const base = s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
  if (looksLikeEmail(base)) return base;
  return base.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function addAlias(db: Db, entityId: string, alias: string): void {
  const norm = normAlias(alias);
  if (!norm) return;
  db.prepare(
    "insert or ignore into entity_aliases (entity_id, alias, alias_norm) values (?, ?, ?)",
  ).run(entityId, alias.trim(), norm);
}

/** The user's own person entity, created on first use. */
export function userEntityId(db: Db): string {
  const row = db.prepare("select value from settings where key = ?").get(USER_ENTITY_KEY) as
    | { value: string }
    | undefined;
  const existing = row ? (JSON.parse(row.value) as string) : null;
  if (existing && db.prepare("select 1 from entities where id = ?").get(existing)) return existing;
  const id = ulid();
  db.prepare(
    "insert into entities (id, kind, display_name, meta, unconfirmed) values (?, 'person', 'Me', '{}', 0)",
  ).run(id);
  for (const a of ["me", "myself"]) addAlias(db, id, a);
  db.prepare("insert or replace into settings (key, value) values (?, ?)").run(
    USER_ENTITY_KEY,
    JSON.stringify(id),
  );
  return id;
}

export interface ResolveInput {
  name: string;
  kind?: EntityKind;
  email?: string | null;
}

/**
 * Resolves a name to an entity (assistant.md step 4): "me"/"I" → the user; exact email match;
 * then alias_norm; else a new entity flagged `unconfirmed` for the user to confirm or merge.
 */
export function resolveEntity(db: Db, input: ResolveInput): string {
  const name = input.name.trim();
  if (SELF.has(name.toLowerCase())) return userEntityId(db);
  const email = input.email?.trim() || (looksLikeEmail(name) ? name : null);
  if (email) {
    const hit = db
      .prepare("select id from entities where lower(primary_email) = lower(?)")
      .get(email) as { id: string } | undefined;
    if (hit) {
      if (!looksLikeEmail(name)) addAlias(db, hit.id, name);
      return hit.id;
    }
  }
  const norm = normAlias(name);
  const kind = input.kind ?? "person";
  const byAlias = db
    .prepare(
      `select e.id from entity_aliases a join entities e on e.id = a.entity_id
       where a.alias_norm = ? order by (e.kind = ?) desc, e.unconfirmed asc limit 1`,
    )
    .get(norm, kind) as { id: string } | undefined;
  if (byAlias) {
    if (email)
      db.prepare("update entities set primary_email = coalesce(primary_email, ?) where id = ?").run(
        email,
        byAlias.id,
      );
    return byAlias.id;
  }
  const id = ulid();
  db.prepare(
    "insert into entities (id, kind, display_name, primary_email, meta, unconfirmed) values (?, ?, ?, ?, '{}', 1)",
  ).run(id, kind, name, email);
  addAlias(db, id, name);
  if (email) addAlias(db, id, email);
  return id;
}

/** Adds extra spellings ("Pri", "Dr. Shah") to an entity. */
export function addAliases(db: Db, entityId: string, aliases: string[]): void {
  for (const a of aliases) addAlias(db, entityId, a);
}

/**
 * Folds `dropId` into `keepId`: aliases, document links, commitment and decision owners move,
 * then `dropId` is deleted. The kept entity becomes confirmed.
 */
export function mergeEntities(db: Db, keepId: string, dropId: string): void {
  if (keepId === dropId) throw new Error("Cannot merge an entity into itself");
  db.transaction(() => {
    const keep = db.prepare("select id from entities where id = ?").get(keepId);
    const drop = db
      .prepare("select display_name, primary_email from entities where id = ?")
      .get(dropId) as { display_name: string; primary_email: string | null } | undefined;
    if (!keep || !drop) throw new Error("Entity not found");
    db.prepare(
      `insert or ignore into entity_aliases (entity_id, alias, alias_norm)
       select ?, alias, alias_norm from entity_aliases where entity_id = ?`,
    ).run(keepId, dropId);
    addAlias(db, keepId, drop.display_name);
    db.prepare(
      `insert or ignore into document_entities (document_id, entity_id, role)
       select document_id, ?, role from document_entities where entity_id = ?`,
    ).run(keepId, dropId);
    db.prepare("update commitments set owner_entity_id = ? where owner_entity_id = ?").run(
      keepId,
      dropId,
    );
    db.prepare(
      "update commitments set counterparty_entity_id = ? where counterparty_entity_id = ?",
    ).run(keepId, dropId);
    db.prepare("update decisions set owner_entity_id = ? where owner_entity_id = ?").run(
      keepId,
      dropId,
    );
    db.prepare(
      "update entities set primary_email = coalesce(primary_email, ?), unconfirmed = 0 where id = ?",
    ).run(drop.primary_email, keepId);
    db.prepare("delete from entities where id = ?").run(dropId);
    const userId = db.prepare("select value from settings where key = ?").get(USER_ENTITY_KEY) as
      | { value: string }
      | undefined;
    if (userId && JSON.parse(userId.value) === dropId)
      db.prepare("update settings set value = ? where key = ?").run(
        JSON.stringify(keepId),
        USER_ENTITY_KEY,
      );
  })();
}

interface EntityRow {
  id: string;
  kind: EntityKind;
  display_name: string;
  primary_email: string | null;
  unconfirmed: number;
  aliases: string | null;
}

const toEntity = (r: EntityRow): Entity => ({
  id: r.id,
  kind: r.kind,
  displayName: r.display_name,
  primaryEmail: r.primary_email,
  unconfirmed: r.unconfirmed === 1,
  aliases: r.aliases ? (JSON.parse(r.aliases) as string[]) : [],
});

/** Entities whose name, alias or email contains `q` (all when empty), confirmed ones first. */
export function listEntities(db: Db, q = "", limit = 50): Entity[] {
  const norm = `%${normAlias(q)}%`;
  const rows = db
    .prepare(
      `select e.id, e.kind, e.display_name, e.primary_email, e.unconfirmed,
         (select json_group_array(alias) from entity_aliases where entity_id = e.id) as aliases
       from entities e
       where ? = '%%' or exists (select 1 from entity_aliases a where a.entity_id = e.id and a.alias_norm like ?)
         or lower(coalesce(e.primary_email, '')) like ?
       order by e.unconfirmed, e.display_name collate nocase limit ?`,
    )
    .all(norm, norm, `%${q.toLowerCase()}%`, limit) as EntityRow[];
  return rows.map(toEntity);
}

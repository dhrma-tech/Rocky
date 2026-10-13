import { type AskResult, AskResultSchema, type Scope, ScopeSchema } from "@rocky/contracts";
import { ulid } from "ulid";
import type { Db } from "../store/db.ts";

/**
 * Chat history (UI spec 5, D-053): each verified answer is kept with its question, so a
 * conversation reopens as it was. Answers quote their sources, so deleting a source deletes
 * the turns that cite it (deletion/service.ts), like briefs and routine output.
 */

export interface ConversationSummary {
  id: string;
  title: string;
  scope: Scope;
  turns: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationTurn {
  id: string;
  question: string;
  result: AskResult;
  createdAt: number;
}

interface Row {
  id: string;
  title: string;
  scope: string;
  created_at: number;
  updated_at: number;
  turns?: number;
}

const toSummary = (r: Row): ConversationSummary => ({
  id: r.id,
  title: r.title,
  scope: ScopeSchema.parse(JSON.parse(r.scope)),
  turns: r.turns ?? 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** A conversation's title is its first question, shortened. */
const titleOf = (q: string) => {
  const one = q.replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
};

export function createConversation(db: Db, scope: Scope = {}, now = Date.now()): string {
  const id = ulid(now);
  db.prepare(
    "insert into conversations (id, title, scope, created_at, updated_at) values (?, '', ?, ?, ?)",
  ).run(id, JSON.stringify(ScopeSchema.parse(scope)), now, now);
  return id;
}

export function listConversations(db: Db, limit = 50): ConversationSummary[] {
  return (
    db
      .prepare(
        `select c.*, (select count(*) from conversation_turns t where t.conversation_id = c.id) as turns
         from conversations c where exists (select 1 from conversation_turns t where t.conversation_id = c.id)
         order by c.updated_at desc limit ?`,
      )
      .all(limit) as Row[]
  ).map(toSummary);
}

export function getConversation(
  db: Db,
  id: string,
): (ConversationSummary & { history: ConversationTurn[] }) | null {
  const row = db.prepare("select * from conversations where id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const history = (
    db
      .prepare(
        "select id, question, answer, created_at from conversation_turns where conversation_id = ? order by ord",
      )
      .all(id) as { id: string; question: string; answer: string; created_at: number }[]
  ).flatMap((t) => {
    // A turn saved by an older format is skipped rather than breaking the conversation.
    const parsed = AskResultSchema.safeParse(JSON.parse(t.answer));
    return parsed.success
      ? [{ id: t.id, question: t.question, result: parsed.data, createdAt: t.created_at }]
      : [];
  });
  return { ...toSummary({ ...row, turns: history.length }), history };
}

export function appendTurn(
  db: Db,
  conversationId: string,
  question: string,
  result: AskResult,
  now = Date.now(),
): string {
  const id = ulid(now);
  db.transaction(() => {
    const ord = (
      db
        .prepare(
          "select coalesce(max(ord), -1) + 1 as n from conversation_turns where conversation_id = ?",
        )
        .get(conversationId) as { n: number }
    ).n;
    db.prepare(
      "insert into conversation_turns (id, conversation_id, ord, question, answer, created_at) values (?, ?, ?, ?, ?, ?)",
    ).run(id, conversationId, ord, question, JSON.stringify(result), now);
    db.prepare(
      "update conversations set updated_at = ?, title = case when title = '' then ? else title end where id = ?",
    ).run(now, titleOf(question), conversationId);
  })();
  return id;
}

export function deleteConversation(db: Db, id: string): boolean {
  return db.prepare("delete from conversations where id = ?").run(id).changes > 0;
}

/**
 * Deletes turns whose answer cites, or lists as a closest match, any of these documents. Called
 * inside deleteData's transaction.
 */
export function deleteTurnsCiting(db: Db, documentIds: string[]): number {
  if (!documentIds.length) return 0;
  const inDocs = `(${documentIds.map(() => "?").join(", ")})`;
  return db
    .prepare(
      `delete from conversation_turns where exists (
         select 1 from json_each(conversation_turns.answer, '$.answer') s, json_each(s.value, '$.citations') c
         where json_extract(c.value, '$.documentId') in ${inDocs})
       or exists (
         select 1 from json_each(conversation_turns.answer, '$.closestMatches') m
         where json_extract(m.value, '$.documentId') in ${inDocs})`,
    )
    .run(...documentIds, ...documentIds).changes;
}

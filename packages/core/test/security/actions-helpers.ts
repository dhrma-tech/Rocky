import type { Citation } from "@rocky/contracts";
import { echoAction } from "../../src/actions/echo.ts";
import { ActionRegistry } from "../../src/actions/registry.ts";
import { ActionService } from "../../src/actions/service.ts";
import type { Db } from "../../src/index.ts";
import { markdownBlocks } from "../../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../../src/ingest/upsert.ts";
import { memoryDb } from "../helpers.ts";

/** A document with one chunk, cited by test proposals. */
export function seedCitation(db: Db, opts: { suspicious?: boolean } = {}): Citation {
  const { text, blocks } = markdownBlocks(
    "# Standup\n\nWe agreed Sam opens a ticket for the login bug.",
  );
  const { documentId } = upsertDocument(db, {
    parsed: {
      title: "Standup",
      sourceType: "markdown",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    externalId: `standup-${Math.random()}`,
  });
  if (opts.suspicious)
    db.prepare("update documents set suspicious = 1 where id = ?").run(documentId);
  const chunk = db.prepare("select id from chunks where document_id = ?").get(documentId) as {
    id: string;
  };
  return {
    chunkId: chunk.id,
    documentId,
    title: "Standup",
    anchor: { kind: "text" },
    quote: "Sam opens a ticket for the login bug",
  };
}

export function actionsWorld() {
  const db = memoryDb();
  const registry = new ActionRegistry();
  const echo = echoAction();
  registry.register(echo.def);
  let t = 1_000;
  const svc = new ActionService(db, registry, { now: () => ++t });
  const cite = seedCitation(db);
  const propose = (message = "open a ticket", extra: { origin?: string } = {}) =>
    svc.propose({
      type: "test.echo",
      payload: { message },
      origin: extra.origin ?? "user_turn",
      citations: [cite],
    });
  return { db, registry, svc, calls: echo.calls, cite, propose };
}

export const auditTypes = (db: Db) =>
  (
    db.prepare("select event_type from audit_log order by seq").all() as { event_type: string }[]
  ).map((r) => r.event_type);

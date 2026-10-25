import type { Commitment } from "@rocky/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HEADS_UP_THRESHOLD,
  headsUpSentence,
  type PastHeadsUp,
  pickHeadsUps,
  runHeadsUps,
  scoreCommitment,
} from "../src/assistant/heads-up.ts";
import { USER_ENTITY_KEY } from "../src/entities/entities.ts";
import type { Db } from "../src/index.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { dismissNotifications, listNotifications } from "../src/notifications/notifier.ts";
import { memoryDb } from "./helpers.ts";

const DAY = 86_400_000;
// Wednesday 7 October 2026, 09:00 local.
const NOW = new Date(2026, 9, 7, 9, 0).getTime();

function commitment(p: Partial<Commitment> & { id: string }): Commitment {
  return {
    text: `Thing ${p.id}`,
    ownerEntityId: null,
    ownerName: null,
    counterpartyName: null,
    deadline: null,
    deadlineText: null,
    status: "open",
    documentId: `doc-${p.id}`,
    documentTitle: "Doc",
    meetingId: null,
    chunkId: null,
    anchor: { kind: "text" },
    evidenceQuote: "",
    confidence: null,
    userEdited: false,
    createdAt: NOW - DAY,
    ...p,
  } as Commitment;
}

const dismissed = (c: Commitment, at = NOW - DAY): PastHeadsUp => ({
  commitmentId: c.id,
  at: at - DAY,
  dismissedAt: at,
  text: c.text,
  counterpartyName: c.counterpartyName,
  documentId: c.documentId,
});

describe("heads-up scoring", () => {
  it("rises as the date nears, fades long overdue, ignores fresh undated ones", () => {
    const s = (deadline: number | null, createdAt = NOW - DAY) =>
      scoreCommitment(commitment({ id: "a", deadline, createdAt }), [], NOW);
    expect(s(NOW + DAY)).toBeGreaterThan(s(NOW + 5 * DAY));
    expect(s(NOW + 5 * DAY)).toBeGreaterThan(s(NOW + 10 * DAY));
    expect(s(NOW + 10 * DAY)).toBe(0);
    expect(s(NOW - DAY)).toBeGreaterThan(s(NOW - 30 * DAY));
    expect(s(NOW - 30 * DAY)).toBeGreaterThanOrEqual(HEADS_UP_THRESHOLD);
    expect(s(null)).toBeLessThan(HEADS_UP_THRESHOLD);
    expect(s(null, NOW - 30 * DAY)).toBeGreaterThanOrEqual(HEADS_UP_THRESHOLD);
  });

  it("a low-confidence extraction scores lower", () => {
    const sure = commitment({ id: "a", deadline: NOW + 2 * DAY, confidence: 1 });
    const unsure = commitment({ id: "b", deadline: NOW + 2 * DAY, confidence: 0.2 });
    expect(scoreCommitment(unsure, [], NOW)).toBeLessThan(scoreCommitment(sure, [], NOW));
  });

  it("a dismissal sinks that commitment and lowers similar ones, not others", () => {
    const a = commitment({ id: "a", text: "Send Sam the budget draft", deadline: NOW + DAY });
    const like = commitment({ id: "b", text: "Send Sam the budget numbers", deadline: NOW + DAY });
    const other = commitment({ id: "c", text: "Book the dentist", deadline: NOW + DAY });
    const past = [dismissed(a)];
    expect(scoreCommitment(a, past, NOW)).toBeLessThan(HEADS_UP_THRESHOLD);
    expect(scoreCommitment(like, past, NOW)).toBeLessThan(scoreCommitment(like, [], NOW));
    expect(scoreCommitment(other, past, NOW)).toBe(scoreCommitment(other, [], NOW));
    // Same person counts as similar too; a dismissal two months old no longer does.
    const sam = commitment({ id: "d", text: "Call", counterpartyName: "Sam", deadline: NOW + DAY });
    const samPast = [{ ...dismissed(a), counterpartyName: "Sam" }];
    expect(scoreCommitment(sam, samPast, NOW)).toBeLessThan(scoreCommitment(sam, [], NOW));
    expect(scoreCommitment(like, [dismissed(a, NOW - 61 * DAY)], NOW)).toBe(
      scoreCommitment(like, [], NOW),
    );
  });
});

describe("picking heads-ups", () => {
  const due = (id: string, days: number) => commitment({ id, deadline: NOW + days * DAY });

  it("over the threshold, highest first, within the room left today", () => {
    const list = [due("far", 6.5), due("soon", 1), due("now", 0.1), due("later", 20)];
    expect(pickHeadsUps(list, [], NOW, 5).map((p) => p.commitment.id)).toEqual(["now", "soon"]);
    expect(pickHeadsUps(list, [], NOW, 1).map((p) => p.commitment.id)).toEqual(["now"]);
    expect(pickHeadsUps(list, [], NOW, 0)).toEqual([]);
  });

  it("skips one nudged in the last three days, and anything not open", () => {
    const a = due("a", 1);
    const nudged: PastHeadsUp = { ...dismissed(a), at: NOW - DAY, dismissedAt: null };
    expect(pickHeadsUps([a], [nudged], NOW, 3)).toEqual([]);
    expect(pickHeadsUps([a], [{ ...nudged, at: NOW - 4 * DAY }], NOW, 3)).toHaveLength(1);
    expect(pickHeadsUps([{ ...a, status: "done" }], [], NOW, 3)).toEqual([]);
  });

  it("says when, what and for whom in one sentence", () => {
    const c = commitment({ id: "a", text: "Send  the\nbudget", counterpartyName: "Sam" });
    expect(headsUpSentence({ ...c, deadline: NOW + DAY }, NOW)).toBe(
      "Due tomorrow: Send the budget (for Sam)",
    );
    expect(headsUpSentence({ ...c, deadline: NOW + 2 * DAY }, NOW)).toBe(
      "Due Friday: Send the budget (for Sam)",
    );
    expect(headsUpSentence({ ...c, deadline: NOW - 3 * 60_000 }, NOW)).toBe(
      "Overdue since today: Send the budget (for Sam)",
    );
    expect(headsUpSentence({ ...c, createdAt: NOW - 30 * DAY }, NOW)).toBe(
      "Still open after 30 days: Send the budget (for Sam)",
    );
  });
});

describe("the daily run", () => {
  let db: Db;
  let doc: string;
  let n = 0;

  beforeEach(() => {
    db = memoryDb();
    const { text, blocks } = markdownBlocks("# Notes\n\nI'll send the budget.");
    doc = upsertDocument(db, {
      parsed: {
        title: "Notes",
        sourceType: "markdown",
        text,
        units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
      },
      externalId: "notes",
      createdAt: NOW - DAY,
    }).documentId;
    db.prepare(
      "insert into entities (id, kind, display_name, meta, unconfirmed) values ('me', 'person', 'Me', '{}', 0), ('sam', 'person', 'Sam', '{}', 0)",
    ).run();
    db.prepare("insert into settings (key, value) values (?, ?)").run(
      USER_ENTITY_KEY,
      JSON.stringify("me"),
    );
  });
  afterEach(() => db.close());

  const add = (text: string, deadline: number | null, owner: string | null = null) => {
    const id = `c${++n}`;
    db.prepare(
      `insert into commitments (id, text, owner_entity_id, counterparty_entity_id, deadline, status, source_document_id, anchor, evidence_quote, created_at, updated_at)
       values (?, ?, ?, 'sam', ?, 'open', ?, '{}', '', ?, ?)`,
    ).run(id, text, owner, deadline, doc, NOW - DAY, NOW - DAY);
    return id;
  };
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  it("files the user's pressing commitments as heads-ups, once a day, after 08:00", () => {
    add("Send the budget", NOW + DAY, "me");
    add("Review the slides", NOW + 2 * DAY);
    add("Sam sends the contract", NOW + DAY, "sam");
    add("Someday tidy the garage", null, "me");
    expect(runHeadsUps(db, { perDay: 3, now: new Date(2026, 9, 7, 7, 30).getTime() })).toEqual([]);
    const filed = runHeadsUps(db, { perDay: 3, now: NOW });
    expect(filed.map((x) => x.sentence)).toEqual([
      "Due tomorrow: Send the budget (for Sam)",
      "Due Friday: Review the slides (for Sam)",
    ]);
    expect(filed.every((x) => x.kind === "heads_up" && x.link === "/commitments")).toBe(true);
    expect(runHeadsUps(db, { perDay: 3, now: NOW + 60_000 })).toEqual([]);
    expect(listNotifications(db, { tab: "updates" }, NOW).notifications).toHaveLength(2);
  });

  it("keeps to the daily cap, counting what went out earlier today; 0 is off", () => {
    for (let i = 0; i < 5; i++) add(`Task ${i}`, NOW + DAY);
    expect(runHeadsUps(db, { perDay: 0, now: NOW })).toEqual([]);
    expect(runHeadsUps(db, { perDay: 2, now: NOW, force: true })).toHaveLength(2);
    expect(runHeadsUps(db, { perDay: 3, now: NOW + 60_000, force: true })).toHaveLength(1);
  });

  it("dismissing the notification is recorded and keeps that commitment quiet", () => {
    const id = add("Send the budget", NOW + DAY);
    const [first] = runHeadsUps(db, { perDay: 3, now: NOW });
    dismissNotifications(db, [first?.id ?? ""], NOW + 1000);
    expect(
      db.prepare("select dismissed_at from heads_ups where commitment_id = ?").get(id),
    ).toEqual({ dismissed_at: NOW + 1000 });
    expect(runHeadsUps(db, { perDay: 3, now: NOW + 4 * DAY })).toEqual([]);
  });

  it("deleting the source removes the heads-up and its notification", () => {
    add("Send the budget", NOW + DAY);
    runHeadsUps(db, { perDay: 3, now: NOW });
    expect(count("select count(*) as n from notifications")).toBe(1);
    db.prepare("delete from documents where id = ?").run(doc);
    expect(count("select count(*) as n from heads_ups")).toBe(0);
    expect(count("select count(*) as n from notifications")).toBe(0);
  });

  it("only reads: no actions, events or entities come out of it", () => {
    db.prepare("delete from settings where key = ?").run(USER_ENTITY_KEY);
    add("Send the budget", NOW + DAY);
    const before = ["actions_queue", "events", "entities"].map((t) =>
      count(`select count(*) as n from ${t}`),
    );
    expect(runHeadsUps(db, { perDay: 3, now: NOW })).toHaveLength(1);
    expect(
      ["actions_queue", "events", "entities"].map((t) => count(`select count(*) as n from ${t}`)),
    ).toEqual(before);
  });
});

import type { SourceType } from "@rocky/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  briefForEvent,
  briefForNotebook,
  latestBrief,
  nextSlotStart,
} from "../src/assistant/brief.ts";
import type { Db } from "../src/index.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { createNotebook } from "../src/notebooks/service.ts";
import { memoryDb } from "./helpers.ts";
import { fakeProviders, harness } from "./router-helpers.ts";

let db: Db;
const NOW = new Date(2026, 9, 7, 8, 0).getTime();

function add(
  id: string,
  title: string,
  body: string,
  opts: { type?: SourceType; meta?: Record<string, unknown>; at?: number } = {},
) {
  const { text, blocks } = markdownBlocks(body);
  return upsertDocument(db, {
    parsed: {
      title,
      sourceType: opts.type ?? "markdown",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    externalId: id,
    createdAt: opts.at ?? NOW - 86_400_000,
    ...(opts.meta ? { meta: opts.meta } : {}),
  }).documentId;
}

const chunkOf = (docId: string) =>
  (
    db.prepare("select id from chunks where document_id = ? order by seq").get(docId) as {
      id: string;
    }
  ).id;
const isVerify = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("You check whether each claim");

beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

describe("briefs", () => {
  it("event brief: collects mail with attendees and their commitments, verifies, and stores", async () => {
    const event = add("ev1", "Thesis check-in", "# Thesis check-in\n\nWhen: 2026-10-07T15:00", {
      type: "calendar",
      meta: { start: "2026-10-07T15:00:00+05:30", attendeeEmails: ["prof@uni.edu"] },
    });
    const mail = add(
      "mail1",
      "Draft chapter 2",
      "# Draft chapter 2\n\nFrom prof@uni.edu: please send the revised chapter 2 before our next meeting.",
      { type: "email" },
    );
    add("other", "Groceries", "# Groceries\n\nBuy milk.");
    db.prepare(
      "insert into entities (id, kind, display_name, primary_email) values ('e1', 'person', 'Prof', 'prof@uni.edu')",
    ).run();
    db.prepare(
      `insert into commitments (id, text, owner_entity_id, counterparty_entity_id, deadline, status, source_document_id, anchor, evidence_quote, created_at, updated_at)
       values ('c1', 'Send revised chapter 2', null, 'e1', ?, 'open', ?, '{}', 'send the revised chapter 2', 1, 1)`,
    ).run(NOW + 86_400_000, mail);

    const seen: string[] = [];
    const { fetch } = fakeProviders((_p, body) => {
      if (isVerify(body)) return { labels: [{ i: 0, label: "SUPPORTED", reason: "ok" }] };
      seen.push(JSON.stringify(body));
      return {
        sentences: [
          {
            text: "The professor asked for the revised chapter 2 before this meeting.",
            citations: [chunkOf(mail)],
            quote: "please send the revised chapter 2 before our next meeting",
          },
        ],
        notFound: false,
      };
    });
    const h = harness(db, fetch);
    const b = await briefForEvent({ db, router: h.router }, event, { now: NOW });
    expect(b).toMatchObject({
      kind: "event",
      subjectId: event,
      title: "Thesis check-in",
      notFound: false,
    });
    expect(b.answer).toHaveLength(1);
    expect(b.answer[0]?.citations[0]?.documentId).toBe(mail);
    expect(b.facts).toEqual([
      { label: "Due", detail: "Send revised chapter 2", at: NOW + 86_400_000, documentId: mail },
    ]);
    // The prompt carried the mail, not the unrelated note.
    expect(seen[0]).toContain("revised chapter 2");
    expect(seen[0]).not.toContain("Buy milk");
    expect(latestBrief(db, "event", event)?.id).toBe(b.id);
  });

  it("an event that is not a calendar document is refused", async () => {
    const doc = add("x", "Note", "# Note\n\nText.");
    const h = harness(db, fakeProviders(() => ({})).fetch);
    await expect(briefForEvent({ db, router: h.router }, doc)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("class brief: last lecture plus computed exam facts; a local-only notebook stays local", async () => {
    const lecture = add(
      "lec4",
      "Lecture 4",
      "# Lecture 4\n\nA heap keeps the minimum element at the root. Homework 3 covers heaps.",
      { type: "transcript" },
    );
    const nb = createNotebook(db, {
      name: "CS201",
      localOnly: true,
      examDates: [{ title: "Midterm", at: NOW + 5 * 86_400_000 }],
      schedule: [{ day: 3, start: "10:00", end: "11:00" }],
      scope: { documentIds: [lecture], excludedIds: [], rules: {} },
    });
    const { fetch, calls } = fakeProviders((_p, body) =>
      isVerify(body)
        ? { labels: [{ i: 0, label: "SUPPORTED", reason: "ok" }] }
        : {
            sentences: [
              {
                text: "Lecture 4 covered heaps.",
                citations: [chunkOf(lecture)],
                quote: "A heap keeps the minimum element at the root",
              },
            ],
            notFound: false,
          },
    );
    const h = harness(db, fetch);
    const b = await briefForNotebook({ db, router: h.router }, nb.id, { now: NOW });
    expect(b.answer).toHaveLength(1);
    expect(b.facts[0]).toMatchObject({
      label: "Exam",
      detail: expect.stringMatching(/^Midterm: 5 days left/),
    });
    expect(b.startsAt).toBe(new Date(2026, 9, 7, 10, 0).getTime()); // today is a Wednesday
    expect(calls.every((c) => !c.url.includes("anthropic"))).toBe(true);
  });

  it("next slot start rolls to next week once today's slot has begun", () => {
    const wed10 = new Date(2026, 9, 7, 10, 0).getTime();
    expect(nextSlotStart([{ day: 3, start: "10:00" }], wed10)).toBe(wed10 + 7 * 86_400_000);
    expect(nextSlotStart([], wed10)).toBeNull();
  });
});

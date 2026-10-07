import type { SourceType, TimelineItem } from "@rocky/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeDuplicates, parseWhen, timeline } from "../src/assistant/timeline.ts";
import type { Db } from "../src/index.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { createNotebook } from "../src/notebooks/service.ts";
import { memoryDb } from "./helpers.ts";

let db: Db;
const at = (day: number, h = 0, m = 0) => new Date(2026, 9, day, h, m).getTime();

function add(
  id: string,
  title: string,
  type: SourceType,
  meta: Record<string, unknown>,
  connectorId?: string,
) {
  const { text, blocks } = markdownBlocks(`# ${title}\n\nBody.`);
  return upsertDocument(db, {
    parsed: {
      title,
      sourceType: type,
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    externalId: id,
    uri: `https://example.com/${id}`,
    meta,
    ...(connectorId ? { connectorId } : {}),
  }).documentId;
}

beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

describe("timeline (acceptance #4)", () => {
  it("merges calendar, Notion, GitHub, commitments and exams, sorted by time", () => {
    add(
      "ev",
      "Design review",
      "calendar",
      { start: new Date(at(8, 14)).toISOString(), end: new Date(at(8, 15)).toISOString() },
      "gcal",
    );
    add(
      "allday",
      "Hackathon",
      "calendar",
      { start: "2026-10-09", end: "2026-10-10", allDay: true },
      "gcal",
    );
    add(
      "row",
      "Ship onboarding",
      "notion",
      { kind: "row", dates: [{ name: "Due", start: "2026-10-12", end: null }] },
      "notion",
    );
    add("page", "A page", "notion", { kind: "page" }, "notion");
    add(
      "gh",
      "Release 1.2",
      "github",
      { state: "open", dueOn: new Date(at(11, 9)).toISOString(), milestone: "Beta" },
      "github",
    );
    add(
      "ghclosed",
      "Old release",
      "github",
      { state: "closed", dueOn: new Date(at(11, 9)).toISOString() },
      "github",
    );
    // Phase 7 task connectors share the GitHub meta shape (state, dueOn).
    add("td", "Buy lab goggles", "task", { state: "open", dueOn: "2026-10-14" }, "todoist");
    add("ln", "Fix flaky test", "task", { state: "closed", dueOn: "2026-10-14" }, "linear");
    add(
      "cd",
      "Design review",
      "calendar",
      { start: new Date(at(8, 14, 5)).toISOString() },
      "caldav",
    );
    const mail = add("m", "Deck", "email", {});
    db.prepare(
      `insert into commitments (id, text, deadline, status, source_document_id, anchor, evidence_quote, created_at, updated_at)
       values ('c1', 'Send the deck to Priya', ?, 'open', ?, '{}', 'deck', 1, 1), ('c2', 'Done thing', ?, 'done', ?, '{}', 'x', 1, 1)`,
    ).run(at(10, 17), mail, at(10, 17), mail);
    createNotebook(db, { name: "CS201", examDates: [{ title: "Midterm", at: at(13, 9) }] });
    add("late", "Out of range", "calendar", { start: new Date(at(30, 9)).toISOString() }, "gcal");

    const items = timeline(db, { from: at(7), to: at(21) });
    expect(items.map((i) => [i.kind, i.title, i.source])).toEqual([
      ["event", "Design review", "gcal"],
      ["event", "Hackathon", "gcal"],
      ["commitment", "Send the deck to Priya", "commitments"],
      ["task", "Release 1.2 (Beta)", "github"],
      ["notion", "Ship onboarding", "notion"],
      ["exam", "CS201: Midterm", "notebooks"],
      ["task", "Buy lab goggles", "todoist"],
    ]);
    expect(items[1]).toMatchObject({ allDay: true, start: at(9) });
    // The iCloud copy of the design review merged into the Google one.
    expect(items[0]).toMatchObject({
      end: at(8, 15),
      deepLink: "https://example.com/ev",
      mergedFrom: ["caldav"],
    });
    expect(items.at(-1)).toMatchObject({ allDay: true, start: at(14) });
  });

  it("the same thing in two sources becomes one item that names both", () => {
    const base = {
      end: null,
      due: null,
      allDay: false,
      deepLink: null,
      documentId: null,
      mergedFrom: [],
      openIn: [],
    };
    const items: TimelineItem[] = [
      {
        ...base,
        kind: "commitment",
        title: "Send the deck to Priya",
        start: at(10, 17, 20),
        source: "commitments",
      },
      { ...base, kind: "event", title: "Send deck to Priya", start: at(10, 17), source: "gcal" },
      { ...base, kind: "notion", title: "Unrelated", start: at(10, 17), source: "notion" },
      {
        ...base,
        kind: "event",
        title: "Send the deck to Priya",
        start: at(11, 17),
        source: "gcal",
      },
    ];
    const merged = mergeDuplicates(items);
    expect(merged.map((i) => [i.title, i.source, i.mergedFrom])).toEqual([
      ["Send deck to Priya", "gcal", ["commitments"]],
      ["Unrelated", "notion", []],
      ["Send the deck to Priya", "gcal", []],
    ]);
  });

  it("adds Notion Calendar links to Google events only while its virtual connector is on", () => {
    add(
      "ev",
      "Design review",
      "calendar",
      {
        start: new Date(at(8, 14)).toISOString(),
        end: new Date(at(8, 15)).toISOString(),
        iCalUID: "abc123@google.com",
      },
      "gcal",
    );
    const range = { from: at(8), to: at(9) };
    expect(timeline(db, range)[0]?.openIn).toEqual([]);
    db.prepare(
      "insert into connectors (id, kind, display_name, enabled, config, created_at) values ('notion-calendar', 'notion-calendar', 'Notion Calendar', 1, ?, 1)",
    ).run(JSON.stringify({ accountEmail: "me@gmail.com" }));
    const [item] = timeline(db, range);
    expect(item?.openIn).toHaveLength(1);
    const url = new URL(item?.openIn[0]?.url ?? "");
    expect(url.protocol).toBe("cron:");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      accountEmail: "me@gmail.com",
      iCalUID: "abc123@google.com",
      startDate: new Date(at(8, 14)).toISOString(),
      endDate: new Date(at(8, 15)).toISOString(),
      title: "Design review",
    });
    db.prepare("update connectors set enabled = 0").run();
    expect(timeline(db, range)[0]?.openIn).toEqual([]);
  });

  it("reads date-only strings as local midnight", () => {
    expect(parseWhen("2026-10-09")).toEqual({ at: at(9), allDay: true });
    expect(parseWhen("nope")).toBeNull();
  });
});

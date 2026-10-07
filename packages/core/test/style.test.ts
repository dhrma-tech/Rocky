import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildStyleProfile,
  getStyleProfile,
  queueStyleRefresh,
  STYLE_JOB,
  sentSamples,
} from "../src/assistant/style.ts";
import type { Db } from "../src/index.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { memoryDb } from "./helpers.ts";
import { fakeProviders, harness } from "./router-helpers.ts";

let db: Db;
const DAY = 86_400_000;

/** A thread with one message from someone else and one sent by the user. */
function thread(i: number) {
  const mine = `Hi team,\n\nQuick update ${i}: the build is green and I will ship tomorrow.\n\nCheers,\nDev`;
  const theirs = `Is the build green for release ${i}? Please confirm before noon.`;
  const { text, blocks } = markdownBlocks(`${theirs}\n\n${mine}`);
  const split = text.indexOf("Hi team");
  return upsertDocument(db, {
    parsed: {
      title: `Release ${i}`,
      sourceType: "email",
      text,
      units: [
        {
          anchor: { kind: "message", messageId: `in${i}`, threadId: `t${i}` },
          start: 0,
          end: split,
          blocks: blocks.filter((b) => b.start < split),
        },
        {
          anchor: { kind: "message", messageId: `out${i}`, threadId: `t${i}` },
          start: split,
          end: text.length,
          blocks: blocks.filter((b) => b.start >= split),
        },
      ],
    },
    externalId: `t${i}`,
    meta: { sentMessageIds: [`out${i}`] },
  }).documentId;
}

beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

describe("style profile", () => {
  it("learns only from sent messages and keeps verbatim exemplars only", async () => {
    const docs = Array.from({ length: 6 }, (_, i) => thread(i));
    const samples = sentSamples(db);
    expect(samples.length).toBe(6);
    expect(
      samples.every((s) => s.text.includes("Cheers") && !s.text.includes("Please confirm")),
    ).toBe(true);

    let prompt = "";
    const { fetch } = fakeProviders((_p, body) => {
      prompt = JSON.stringify(body);
      return {
        descriptor: "Short, friendly updates; opens with 'Hi team', signs off 'Cheers'.",
        exemplars: ["the build is green and I will ship tomorrow", "Dear Sir, I invented this"],
      };
    });
    const h = harness(db, fetch);
    const p = await buildStyleProfile({ db, router: h.router }, 1000);
    expect(p.exemplars).toEqual(["the build is green and I will ship tomorrow"]);
    expect(prompt).not.toContain("Please confirm before noon");
    expect(getStyleProfile(db)).toMatchObject({
      descriptor: expect.stringContaining("Cheers"),
      updatedAt: 1000,
    });
    const row = db.prepare("select source_document_ids from style_profiles").get() as {
      source_document_ids: string;
    };
    expect(JSON.parse(row.source_document_ids).sort()).toEqual([...docs].sort());
  });

  it("refuses with too little sent mail", async () => {
    thread(1);
    const h = harness(db, fakeProviders(() => ({})).fetch);
    await expect(buildStyleProfile({ db, router: h.router })).rejects.toMatchObject({
      code: "EMPTY",
    });
  });

  it("never reads sent mail in the background before the user builds a profile; then monthly", async () => {
    for (let i = 0; i < 6; i++) thread(i);
    const jobs = () =>
      (db.prepare("select count(*) as n from jobs where type = ?").get(STYLE_JOB) as { n: number })
        .n;
    expect(queueStyleRefresh(db, { now: 10 * DAY })).toBeNull();
    expect(jobs()).toBe(0);
    expect(queueStyleRefresh(db, { now: 10 * DAY, force: true })).not.toBeNull();
    db.prepare("delete from jobs").run();
    const h = harness(db, fakeProviders(() => ({ descriptor: "Brief.", exemplars: [] })).fetch);
    await buildStyleProfile({ db, router: h.router }, 10 * DAY);
    expect(queueStyleRefresh(db, { now: 20 * DAY })).toBeNull();
    expect(queueStyleRefresh(db, { now: 41 * DAY })).not.toBeNull();
  });
});

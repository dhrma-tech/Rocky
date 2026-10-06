// Phase 3 acceptance #3 in CI: the 20 sample transcripts through the full understanding pipeline,
// replaying the local model's recorded replies (spikes/understanding.test.ts with ROCKY_RECORD=1).
// No model runs here; this checks that every recorded run validates and stores cleanly.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getMeetingRow, type Job, understandMeeting } from "../src/index.ts";
import { memoryDb } from "./helpers.ts";
import { harness } from "./router-helpers.ts";
import { RECORDED_DIR, samples, seedSample } from "./understanding-fixtures.ts";

interface Recorded {
  model: string;
  responses: unknown[];
}

const recorded = (id: string): Recorded | null => {
  const f = path.join(RECORDED_DIR, `${id}.json`);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Recorded) : null;
};

/** Serves the recorded Ollama replies in order; fails loudly if the pipeline asks for more. */
function replay(r: Recorded) {
  let i = 0;
  return (async () => {
    const body = r.responses[i++];
    if (body === undefined)
      throw new Error("replay exhausted: the pipeline made an unrecorded call");
    return Response.json(body);
  }) as unknown as typeof fetch;
}

const all = samples();

describe("understanding on 20 recorded sample transcripts", () => {
  it("has a recording for every sample", () => {
    expect(all.map((s) => s.id).filter((id) => !recorded(id))).toEqual([]);
    expect(all).toHaveLength(20);
  });

  for (const s of all) {
    it.skipIf(!recorded(s.id))(`${s.id}: schema-valid, evidence-checked, stored`, async () => {
      const r = recorded(s.id) as Recorded;
      const db = memoryDb();
      const h = harness(db, replay(r));
      h.settings.localOnly = true; // as recorded: every call went to the local model
      const { meetingId, job } = seedSample(db, s);
      const report = await understandMeeting({ db, router: h.router }, job as Job);
      expect(getMeetingRow(db, meetingId)?.transcription_status).toBe("done");
      expect(report).not.toBeNull();

      // Every stored commitment's quote is verbatim in the transcript (non-negotiable #4).
      const text = s.lines.map((l) => l[2].toLowerCase()).join(" ");
      const quotes = db.prepare("select evidence_quote from commitments").all() as {
        evidence_quote: string;
      }[];
      for (const q of quotes)
        expect(text).toContain(
          q.evidence_quote
            .toLowerCase()
            .replace(/[.!?,]+$/, "")
            .replace(/[’]/g, "'"),
        );

      if (s.id === "05-no-commitments") expect(quotes).toEqual([]);
      if (s.id === "07-injection") {
        expect(db.prepare("select count(*) n from actions_queue").get()).toEqual({ n: 0 });
        const texts = (db.prepare("select text from commitments").all() as { text: string }[]).map(
          (c) => c.text,
        );
        expect(texts.join(" ")).not.toMatch(/vendor@example\.com/);
      }
      db.close();
    });
  }
});

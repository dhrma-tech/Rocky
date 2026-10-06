import fs from "node:fs";
import path from "node:path";
import { createMeeting, type Db } from "../src/index.ts";

/** Acceptance #3 (Phase 3): 20 fictional, scrubbed sample transcripts. */
export interface SampleTranscript {
  id: string;
  kind: "meeting" | "lecture";
  title: string;
  lines: [number, "mic" | "system" | "mixed", string][];
}

export const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "understanding");
export const RECORDED_DIR = path.join(FIXTURE_DIR, "recorded");
export const SAMPLE_START = Date.UTC(2026, 9, 6, 10, 0);

export const samples = (): SampleTranscript[] =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "transcripts.json"), "utf8"));

const LABEL = { mic: "You", system: "Others", mixed: "Speaker 1" } as const;

/** Inserts the sample as a transcribed meeting plus a running understand job; returns the job. */
export function seedSample(db: Db, s: SampleTranscript) {
  const { meetingId, documentId } = createMeeting(db, {
    kind: s.kind,
    title: s.title,
    source: "recording",
    startedAt: SAMPLE_START,
    status: "understanding",
  });
  const ins = db.prepare(
    "insert into transcript_segments (id, meeting_id, start_ms, end_ms, channel, speaker_label, text) values (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [i, [t, ch, text]] of s.lines.entries())
    ins.run(`${meetingId}-${i}`, meetingId, t, t + 4500, ch, LABEL[ch], text);
  const job = {
    id: `job-${meetingId}`,
    type: "understand_meeting",
    payload: { meetingId },
    status: "running" as const,
    priority: 0,
    heavy: true,
    attempts: 2,
    maxAttempts: 2,
    runAfter: 0,
    lastError: null,
  };
  db.prepare(
    "insert into jobs (id, type, payload, status, priority, heavy, attempts, max_attempts, run_after, created_at, updated_at) values (?, ?, ?, 'running', 0, 1, 2, 2, 0, 0, 0)",
  ).run(job.id, job.type, JSON.stringify(job.payload));
  return { meetingId, documentId, job };
}

import fs from "node:fs";
import path from "node:path";
import type { Channel } from "@rocky/contracts";
import { ulid } from "ulid";
import { EMBED_JOB } from "../ingest/embed-job.ts";
import { TextBuilder } from "../ingest/parsers/text-blocks.ts";
import type { ParsedDoc, Unit } from "../ingest/types.ts";
import { upsertDocument } from "../ingest/upsert.ts";
import { enqueue, type Job, setJobProgress } from "../jobs/queue.ts";
import { blobPath } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";
import type { ProcessRunner } from "../system/exec.ts";
import { WAV_HEADER_BYTES } from "./audio.ts";
import { dropEchoes } from "./dedup.ts";
import { toWav16k } from "./ffmpeg.ts";
import { CAPTURE_CONNECTOR, getMeetingRow, type MeetingRow, setMeetingStatus } from "./meetings.ts";
import { transcribeWav, type WhisperSegment } from "./whisper-run.ts";

/** Defined here (not in understanding/) so capture doesn't import the extraction pipeline. */
export const UNDERSTAND_JOB = "understand_meeting";

export const SPEAKER: Record<Channel, string> = {
  mic: "You",
  system: "Others",
  mixed: "Speaker 1",
};
const WINDOW_MS = 60_000;

export interface TranscribeDeps {
  db: Db;
  blobsDir: string;
  recDir: string;
  /** Resolved lazily so a missing binary fails the job with a clear message, not the daemon. */
  whisper: () => {
    binary: string | null;
    model: string | null;
    threads: number;
    language: "auto" | "en";
  };
  ffmpeg: () => Promise<string | null>;
  run?: ProcessRunner;
}

export interface LabeledSegment extends WhisperSegment {
  channel: Channel;
  speakerLabel: string;
}

/** Merges per-channel segments into one timeline with You/Others labels, dropping mic echoes. */
export function labelSegments(
  byChannel: Partial<Record<"mic" | "system" | "mixed", WhisperSegment[]>>,
): LabeledSegment[] {
  const { mic, system, mixed } = byChannel;
  let out: LabeledSegment[];
  if (mic && system) {
    out = [
      ...dropEchoes(mic, system).map((s) => ({
        ...s,
        channel: "mic" as const,
        speakerLabel: SPEAKER.mic,
      })),
      ...system.map((s) => ({ ...s, channel: "system" as const, speakerLabel: SPEAKER.system })),
    ];
  } else {
    // A single channel can't tell speakers apart (capture.md): it's "mixed".
    out = (mic ?? system ?? mixed ?? []).map((s) => ({
      ...s,
      channel: "mixed" as const,
      speakerLabel: SPEAKER.mixed,
    }));
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** Transcript text with ≤ 60 s transcript-anchored units, the same shape the .vtt parser produces. */
export function segmentsToParsedDoc(title: string, segs: LabeledSegment[]): ParsedDoc {
  const b = new TextBuilder();
  const units: Unit[] = [];
  let unit: (Unit & { anchor: { kind: "transcript"; startMs: number; endMs: number } }) | undefined;
  for (const s of segs) {
    if (!unit || s.endMs - unit.anchor.startMs > WINDOW_MS) {
      unit = {
        anchor: { kind: "transcript", startMs: s.startMs, endMs: s.endMs },
        start: -1,
        end: -1,
        blocks: [],
      };
      units.push(unit);
    }
    b.add("para", s.channel === "mixed" ? s.text : `${s.speakerLabel}: ${s.text}`);
    const block = b.blocks.at(-1);
    if (!block) continue;
    unit.anchor.endMs = Math.max(unit.anchor.endMs, s.endMs);
    if (unit.start < 0) unit.start = block.start;
    unit.end = block.end;
    unit.blocks.push(block);
  }
  return { title, sourceType: "meeting", text: b.text, units: units.filter((u) => u.start >= 0) };
}

/** The heavy-lane job: media → WAV (imports) → whisper per channel → segments → meeting document. */
export async function transcribeMeeting(deps: TranscribeDeps, job: Job): Promise<void> {
  const { db } = deps;
  const { meetingId } = job.payload as { meetingId: string };
  const m = getMeetingRow(db, meetingId);
  if (!m) return; // Deleted while queued.
  setMeetingStatus(db, meetingId, "transcribing", { jobId: job.id, error: null });
  try {
    await run(deps, job, m);
  } catch (err) {
    const final = job.attempts >= job.maxAttempts;
    const msg = err instanceof Error ? err.message : String(err);
    setMeetingStatus(db, meetingId, final ? "failed" : "queued", { error: msg });
    throw err;
  }
}

async function run(deps: TranscribeDeps, job: Job, m: MeetingRow): Promise<void> {
  const { db } = deps;
  const dir = path.join(deps.recDir, m.id);
  const progress = (p: number, note: string) => setJobProgress(db, job.id, p, note);
  const w = deps.whisper();
  if (!w.binary || !w.model)
    throw new Error("whisper-cli or its model is not installed. Run `rocky doctor --fix`.");

  // Which WAVs to transcribe: recordings have mic/system WAVs; imports are converted first.
  let wavs: Partial<Record<Channel, string>> = {};
  let base = 0;
  if (m.source === "import") {
    if (!m.audio_blob) throw new Error("The imported file is missing.");
    const ffmpeg = await deps.ffmpeg();
    if (!ffmpeg)
      throw new Error("ffmpeg is not installed. Run `rocky doctor --fix` or install ffmpeg.");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, "mixed.wav");
    progress(0, "converting");
    await toWav16k(ffmpeg, blobPath(deps.blobsDir, m.audio_blob), out, {
      onProgress: (p) => progress(p * 0.1, "converting"),
      ...(deps.run ? { run: deps.run } : {}),
    });
    wavs = { mixed: out };
    base = 0.1;
  } else {
    for (const c of ["mic", "system"] as const) {
      const f = path.join(dir, `${c}.wav`);
      if (fs.existsSync(f)) wavs[c] = f;
    }
  }

  const entries = Object.entries(wavs) as [Channel, string][];
  const byChannel: Partial<Record<Channel, WhisperSegment[]>> = {};
  let durationMs = m.duration_ms ?? 0;
  for (const [i, [channel, wav]] of entries.entries()) {
    const span = (0.95 - base) / entries.length;
    const start = base + i * span;
    progress(start, `transcribing ${channel}`);
    durationMs = Math.max(
      durationMs,
      Math.round(((fs.statSync(wav).size - WAV_HEADER_BYTES) / 32_000) * 1000),
    );
    byChannel[channel] = await transcribeWav(wav, {
      binary: w.binary,
      model: w.model,
      threads: w.threads,
      language: w.language,
      onProgress: (p) => progress(start + p * span, `transcribing ${channel}`),
      ...(deps.run ? { run: deps.run } : {}),
    });
  }

  const segs = labelSegments(byChannel);
  const parsed = segmentsToParsedDoc(m.title, segs);
  progress(0.95, "indexing");
  db.transaction(() => {
    db.prepare("delete from transcript_segments where meeting_id = ?").run(m.id);
    const ins = db.prepare(
      `insert into transcript_segments (id, meeting_id, start_ms, end_ms, channel, speaker_label, text, avg_logprob)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of segs)
      ins.run(ulid(), m.id, s.startMs, s.endMs, s.channel, s.speakerLabel, s.text, s.avgLogprob);
    const mime = (
      db.prepare("select mime from documents where id = ?").get(m.document_id) as
        | { mime: string | null }
        | undefined
    )?.mime;
    const res = upsertDocument(db, {
      parsed,
      connectorId: CAPTURE_CONNECTOR,
      externalId: m.id,
      ...(mime ? { mime } : {}),
      ...(m.audio_blob ? { blobHash: m.audio_blob } : {}),
      ...(m.started_at ? { createdAt: m.started_at } : {}),
      meta: { meetingId: m.id, kind: m.kind },
    });
    db.prepare("update meetings set duration_ms = ? where id = ?").run(durationMs || null, m.id);
    if (res.status !== "unchanged")
      enqueue(db, EMBED_JOB, { documentId: res.documentId }, { priority: 1 });
    if (segs.length) {
      const jobId = enqueue(
        db,
        UNDERSTAND_JOB,
        { meetingId: m.id, documentId: m.document_id },
        { heavy: true, priority: 1, maxAttempts: 2 },
      );
      setMeetingStatus(db, m.id, "understanding", { jobId });
    } else {
      setMeetingStatus(db, m.id, "done", { error: "No speech was detected." });
    }
  })();
  progress(1, "done");
  // The WAVs were only needed for whisper; playback uses the blob.
  fs.rmSync(dir, { recursive: true, force: true });
}

import fs from "node:fs";
import path from "node:path";
import type { RecordingStart } from "@rocky/contracts";
import { appendAudit } from "../audit/append.ts";
import { enqueue } from "../jobs/queue.ts";
import { putBlobFile } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";
import { mixPcmFilesToWav, pcmDurationMs, pcmFileToWav } from "./audio.ts";
import { createMeeting, getMeetingRow, setMeetingStatus } from "./meetings.ts";

export const TRANSCRIBE_JOB = "transcribe_meeting";

/** 5 s of 16 kHz Int16 is 160 KB; 1 MB leaves room for a late flush without allowing abuse. */
export const MAX_CHUNK_BYTES = 1 << 20;
/** Chunk numbers are dense from 0; 100k × 5 s is ~6 days, far past any real recording. */
const MAX_CHUNK_INDEX = 100_000;

export type RecChannel = "mic" | "system";

export interface CaptureDirs {
  rec: string;
  blobs: string;
}

export class CaptureError extends Error {
  readonly code: "NOT_FOUND" | "BAD_REQUEST" | "ILLEGAL_TRANSITION";
  constructor(code: CaptureError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const recDir = (dirs: CaptureDirs, id: string) => {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new CaptureError("BAD_REQUEST", "Invalid id");
  return path.join(dirs.rec, id);
};

/** Creates the meeting in `recording` state and writes the consent to the audit log. */
export function startRecording(
  db: Db,
  input: RecordingStart,
  now = Date.now(),
): { meetingId: string; documentId: string } {
  const title =
    input.title ??
    `${input.kind === "lecture" ? "Lecture" : "Meeting"} ${new Date(now).toISOString().slice(0, 16).replace("T", " ")}`;
  return db.transaction(() => {
    const ids = createMeeting(db, {
      kind: input.kind,
      title,
      source: "recording",
      startedAt: now,
      notebookId: input.notebookId,
      calendarEventId: input.calendarEventId,
      consentLoggedAt: now,
      status: "recording",
      now,
    });
    appendAudit(db, {
      eventType: "recording_consent",
      actor: "user",
      subjectType: "meeting",
      subjectId: ids.meetingId,
      meta: { kind: input.kind, participantsInformed: true, lawsAck: true },
      at: now,
    });
    return ids;
  })();
}

function requireRecording(db: Db, id: string) {
  const m = getMeetingRow(db, id);
  if (!m) throw new CaptureError("NOT_FOUND", "Recording not found");
  if (m.transcription_status !== "recording")
    throw new CaptureError("ILLEGAL_TRANSITION", "Recording already stopped");
  return m;
}

/**
 * Stores one 5 s chunk of one channel. Idempotent: a retried PUT overwrites the same file, and
 * chunks may arrive out of order. The daemon never trusts the client for the path: id and n are validated.
 */
export function writeChunk(
  db: Db,
  dirs: CaptureDirs,
  id: string,
  channel: RecChannel,
  n: number,
  bytes: Uint8Array,
): void {
  if (!Number.isInteger(n) || n < 0 || n > MAX_CHUNK_INDEX)
    throw new CaptureError("BAD_REQUEST", "Invalid chunk number");
  if (bytes.length > MAX_CHUNK_BYTES) throw new CaptureError("BAD_REQUEST", "Chunk too large");
  if (bytes.length % 2 !== 0) throw new CaptureError("BAD_REQUEST", "PCM must be 16-bit samples");
  requireRecording(db, id);
  const dir = path.join(recDir(dirs, id), channel);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${n}.pcm`);
  fs.writeFileSync(`${file}.tmp`, bytes);
  fs.renameSync(`${file}.tmp`, file);
}

const chunkNumbers = (dir: string) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .map((f) => /^(\d+)\.pcm$/.exec(f)?.[1])
        .filter((x): x is string => x !== undefined)
        .map(Number)
    : [];

/**
 * Joins each channel's chunks in order into `<channel>.pcm`. Both channels get the same length
 * per chunk index (the shorter is padded with silence) and a missing chunk becomes 5 s of
 * silence, so mic and system timestamps stay aligned.
 */
export function assembleChannels(dir: string): { channels: RecChannel[]; bytes: number } {
  const present = (["mic", "system"] as const).filter(
    (c) => chunkNumbers(path.join(dir, c)).length,
  );
  const last = Math.max(-1, ...present.flatMap((c) => chunkNumbers(path.join(dir, c))));
  const outs = Object.fromEntries(
    present.map((c) => [c, fs.openSync(path.join(dir, `${c}.pcm`), "w")]),
  ) as Record<RecChannel, number>;
  let bytes = 0;
  try {
    for (let n = 0; n <= last; n++) {
      const parts = present.map((c) => {
        const f = path.join(dir, c, `${n}.pcm`);
        return fs.existsSync(f) ? fs.readFileSync(f) : null;
      });
      const len = Math.max(...parts.map((p) => p?.length ?? 0)) || 160_000;
      present.forEach((c, i) => {
        const buf = Buffer.alloc(len);
        parts[i]?.copy(buf);
        fs.writeSync(outs[c], buf);
      });
      bytes += len;
    }
  } finally {
    for (const fd of Object.values(outs)) fs.closeSync(fd);
  }
  for (const c of present) fs.rmSync(path.join(dir, c), { recursive: true, force: true });
  return { channels: present, bytes };
}

/**
 * Stop: assembles the chunks, writes per-channel WAVs for whisper and a mixed WAV for playback
 * (stored as a blob), then queues transcription on the heavy lane.
 */
export async function finishRecording(
  db: Db,
  dirs: CaptureDirs,
  id: string,
  now = Date.now(),
): Promise<{ jobId: string }> {
  const m = requireRecording(db, id);
  const dir = recDir(dirs, id);
  // Claim the transition first so a double-clicked Stop can't assemble twice.
  const claimed = db
    .prepare(
      "update meetings set transcription_status = 'queued' where id = ? and transcription_status = 'recording'",
    )
    .run(id).changes;
  if (!claimed) throw new CaptureError("ILLEGAL_TRANSITION", "Recording already stopped");

  let channels: RecChannel[];
  let bytes: number;
  let audioBlob: string | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    ({ channels, bytes } = assembleChannels(dir));
    // Mix from the raw PCM: the channel WAVs start with a header that isn't audio.
    if (channels.length) {
      const playback = path.join(dir, "playback.wav");
      mixPcmFilesToWav(
        channels.map((c) => path.join(dir, `${c}.pcm`)),
        playback,
      );
      audioBlob = await putBlobFile(dirs.blobs, playback, { move: true });
    }
    for (const c of channels) {
      pcmFileToWav(path.join(dir, `${c}.pcm`), path.join(dir, `${c}.wav`));
      fs.rmSync(path.join(dir, `${c}.pcm`), { force: true });
    }
  } catch (err) {
    setMeetingStatus(db, id, "failed", {
      error: `Could not assemble the recording: ${String(err)}`,
    });
    throw err;
  }
  return db.transaction(() => {
    db.prepare(
      "update meetings set ended_at = ?, duration_ms = ?, audio_blob = ? where id = ?",
    ).run(now, pcmDurationMs(bytes), audioBlob, id);
    db.prepare("update documents set blob_hash = ?, mime = 'audio/wav' where id = ?").run(
      audioBlob,
      m.document_id,
    );
    const jobId = enqueue(
      db,
      TRANSCRIBE_JOB,
      { meetingId: id, documentId: m.document_id },
      { heavy: true, priority: 2, maxAttempts: 2, now },
    );
    setMeetingStatus(db, id, "queued", { jobId, error: null });
    return { jobId };
  })();
}

/** Recordings still in progress (or orphaned by a closed tab), newest first. */
export function activeRecordings(db: Db): { id: string; title: string; startedAt: number }[] {
  return db
    .prepare(
      `select id, title, started_at as startedAt from meetings
       where transcription_status = 'recording' order by started_at desc`,
    )
    .all() as { id: string; title: string; startedAt: number }[];
}

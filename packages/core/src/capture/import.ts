import path from "node:path";
import type { MeetingKind } from "@rocky/contracts";
import { enqueue } from "../jobs/queue.ts";
import { putBlobFile } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";
import { createMeeting, setMeetingStatus } from "./meetings.ts";
import { TRANSCRIBE_JOB } from "./recordings.ts";

/** Browser-playable types get their real mime; anything else ffmpeg reads is still transcribed. */
const MEDIA_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
};

export const isMediaFile = (file: string) => path.extname(file).toLowerCase() in MEDIA_MIME;

export interface MediaImportInput {
  file: string;
  kind?: MeetingKind;
  title?: string | undefined;
  notebookId?: string | undefined;
  /** Original filename when `file` is an upload temp file. */
  filename?: string;
  /** Move `file` into the blob store instead of copying it (uploads). */
  move?: boolean;
}

/**
 * Stores the original file as the meeting's playback blob and queues transcription. ffmpeg runs
 * inside the job, so a big lecture import returns immediately.
 */
export async function importMedia(
  db: Db,
  blobsDir: string,
  input: MediaImportInput,
): Promise<{ meetingId: string; documentId: string; jobId: string }> {
  const name = input.filename ?? path.basename(input.file);
  const ext = path.extname(name).toLowerCase();
  const audioBlob = await putBlobFile(blobsDir, input.file, { move: input.move ?? false });
  return db.transaction(() => {
    const ids = createMeeting(db, {
      kind: input.kind ?? "lecture",
      title: input.title ?? path.basename(name, ext),
      source: "import",
      notebookId: input.notebookId,
      audioBlob,
      mime: MEDIA_MIME[ext] ?? "application/octet-stream",
      status: "queued",
    });
    const jobId = enqueue(
      db,
      TRANSCRIBE_JOB,
      { meetingId: ids.meetingId, documentId: ids.documentId },
      {
        heavy: true,
        priority: 1,
        maxAttempts: 2,
      },
    );
    setMeetingStatus(db, ids.meetingId, "queued", { jobId });
    return { ...ids, jobId };
  })();
}

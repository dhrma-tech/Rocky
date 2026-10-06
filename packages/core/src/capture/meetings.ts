import type { MeetingKind, TranscriptionStatus } from "@rocky/contracts";
import { ulid } from "ulid";
import type { Db } from "../store/db.ts";

/** Meeting documents are owned by this pseudo connector; the external id is the meeting id. */
export const CAPTURE_CONNECTOR = "capture";

export interface NewMeeting {
  kind: MeetingKind;
  title: string;
  source: "recording" | "import";
  startedAt?: number;
  notebookId?: string | undefined;
  calendarEventId?: string | undefined;
  audioBlob?: string;
  mime?: string;
  consentLoggedAt?: number;
  status: TranscriptionStatus;
  now?: number;
}

/**
 * Creates a meeting and its (still empty) document. `meetings.document_id` is NOT NULL, so the
 * document exists from the start; the transcribe job later fills it via upsertDocument, which
 * finds it by (capture, meetingId).
 */
export function createMeeting(db: Db, m: NewMeeting): { meetingId: string; documentId: string } {
  const now = m.now ?? Date.now();
  const meetingId = ulid(now);
  const documentId = ulid(now);
  db.transaction(() => {
    db.prepare(
      `insert into documents (id, connector_id, external_id, source_type, mime, title, created_at, updated_at,
       ingested_at, raw_text, content_hash, meta, blob_hash) values (?, ?, ?, 'meeting', ?, ?, ?, ?, ?, '', '', ?, ?)`,
    ).run(
      documentId,
      CAPTURE_CONNECTOR,
      meetingId,
      m.mime ?? null,
      m.title,
      m.startedAt ?? now,
      now,
      now,
      JSON.stringify({ meetingId }),
      m.audioBlob ?? null,
    );
    db.prepare(
      `insert into meetings (id, document_id, title, started_at, kind, notebook_id, audio_blob, consent_logged_at,
       transcription_status, calendar_event_external_id, source) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      meetingId,
      documentId,
      m.title,
      m.startedAt ?? now,
      m.kind,
      m.notebookId ?? null,
      m.audioBlob ?? null,
      m.consentLoggedAt ?? null,
      m.status,
      m.calendarEventId ?? null,
      m.source,
    );
  })();
  return { meetingId, documentId };
}

export interface MeetingRow {
  id: string;
  document_id: string;
  title: string;
  started_at: number | null;
  ended_at: number | null;
  kind: MeetingKind;
  notebook_id: string | null;
  audio_blob: string | null;
  consent_logged_at: number | null;
  transcription_status: TranscriptionStatus;
  source: "recording" | "import";
  duration_ms: number | null;
  job_id: string | null;
  error: string | null;
  summary: string | null;
}

export function getMeetingRow(db: Db, id: string): MeetingRow | undefined {
  return db.prepare("select * from meetings where id = ?").get(id) as MeetingRow | undefined;
}

export function setMeetingStatus(
  db: Db,
  id: string,
  status: TranscriptionStatus,
  extra: { error?: string | null; jobId?: string | null } = {},
): void {
  db.prepare(
    `update meetings set transcription_status = ?,
       error = case when ? then ? else error end,
       job_id = case when ? then ? else job_id end
     where id = ?`,
  ).run(
    status,
    extra.error !== undefined ? 1 : 0,
    extra.error ?? null,
    extra.jobId !== undefined ? 1 : 0,
    extra.jobId ?? null,
    id,
  );
}

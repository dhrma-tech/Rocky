import {
  AnchorSchema,
  type Commitment,
  type CommitmentCreate,
  type CommitmentPatch,
  type CommitmentStatus,
  type Decision,
  type Meeting,
  type MeetingDetail,
  type StoredSummary,
  type TranscriptSegment,
} from "@rocky/contracts";
import { ulid } from "ulid";
import { appendAudit } from "../audit/append.ts";
import { enqueue } from "../jobs/queue.ts";
import type { Db } from "../store/db.ts";
import { getMeetingRow, type MeetingRow, setMeetingStatus } from "./meetings.ts";
import { TRANSCRIBE_JOB } from "./recordings.ts";
import { UNDERSTAND_JOB } from "./transcribe-job.ts";

/** Read models and edits behind the Meetings and Commitments screens (ui.md, Phase 3). */

export class NotFound extends Error {
  readonly code = "NOT_FOUND";
}

const toMeeting = (r: MeetingRow & { commitment_count: number }): Meeting => ({
  id: r.id,
  documentId: r.document_id,
  title: r.title,
  kind: r.kind,
  source: r.source,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  durationMs: r.duration_ms,
  status: r.transcription_status,
  error: r.error,
  jobId: r.job_id,
  audioUrl: r.audio_blob ? `/api/v1/blobs/${r.audio_blob}` : null,
  notebookId: r.notebook_id,
  commitmentCount: r.commitment_count,
});

const MEETING_SELECT = `select m.*, (select count(*) from commitments c where c.source_document_id = m.document_id) as commitment_count
  from meetings m`;

export function listMeetings(db: Db, opts: { limit?: number; before?: number } = {}): Meeting[] {
  const rows = db
    .prepare(
      `${MEETING_SELECT} where coalesce(m.started_at, 0) < ? order by m.started_at desc limit ?`,
    )
    .all(opts.before ?? Number.MAX_SAFE_INTEGER, Math.min(opts.limit ?? 50, 200)) as (MeetingRow & {
    commitment_count: number;
  })[];
  return rows.map(toMeeting);
}

export function getMeeting(db: Db, id: string): Meeting {
  const row = db.prepare(`${MEETING_SELECT} where m.id = ?`).get(id) as
    | (MeetingRow & { commitment_count: number })
    | undefined;
  if (!row) throw new NotFound("meeting not found");
  return toMeeting(row);
}

export function meetingSegments(
  db: Db,
  meetingId: string,
  range?: { fromMs: number; toMs: number },
): TranscriptSegment[] {
  const rows = db
    .prepare(
      `select id, start_ms, end_ms, channel, speaker_label, text from transcript_segments
       where meeting_id = ? and end_ms >= ? and start_ms <= ? order by start_ms, end_ms`,
    )
    .all(meetingId, range?.fromMs ?? 0, range?.toMs ?? Number.MAX_SAFE_INTEGER) as {
    id: string;
    start_ms: number;
    end_ms: number;
    channel: TranscriptSegment["channel"];
    speaker_label: string | null;
    text: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    startMs: r.start_ms,
    endMs: r.end_ms,
    channel: r.channel,
    speakerLabel: r.speaker_label ?? "Speaker 1",
    text: r.text,
  }));
}

interface CommitmentRow {
  id: string;
  text: string;
  owner_entity_id: string | null;
  owner_name: string | null;
  counterparty_name: string | null;
  deadline: number | null;
  deadline_text: string | null;
  status: CommitmentStatus;
  source_document_id: string;
  document_title: string;
  meeting_id: string | null;
  anchor: string;
  evidence_quote: string;
  confidence: number | null;
  user_edited: number;
  created_at: number;
}

/** SQL fragments with their bound values, for filters and partial updates. */
function clauses() {
  const parts: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    parts.push(sql);
    args.push(value);
  };
  return { parts, args, add };
}

const parseAnchor = (s: string) => {
  const r = AnchorSchema.safeParse(JSON.parse(s || "{}"));
  return r.success ? r.data : { kind: "text" as const };
};

const toCommitment = (r: CommitmentRow): Commitment => ({
  id: r.id,
  text: r.text,
  ownerEntityId: r.owner_entity_id,
  ownerName: r.owner_name,
  counterpartyName: r.counterparty_name,
  deadline: r.deadline,
  deadlineText: r.deadline_text,
  status: r.status,
  documentId: r.source_document_id,
  documentTitle: r.document_title,
  meetingId: r.meeting_id,
  anchor: parseAnchor(r.anchor),
  evidenceQuote: r.evidence_quote,
  confidence: r.confidence,
  userEdited: r.user_edited === 1,
  createdAt: r.created_at,
});

const COMMITMENT_SELECT = `select c.*, o.display_name as owner_name, cp.display_name as counterparty_name,
    d.title as document_title, m.id as meeting_id
  from commitments c
  join documents d on d.id = c.source_document_id
  left join entities o on o.id = c.owner_entity_id
  left join entities cp on cp.id = c.counterparty_entity_id
  left join meetings m on m.document_id = c.source_document_id`;

export interface CommitmentFilter {
  status?: CommitmentStatus | undefined;
  ownerEntityId?: string | undefined;
  dueBefore?: number | undefined;
  dueAfter?: number | undefined;
  documentId?: string | undefined;
  limit?: number | undefined;
}

/** Open work first, soonest deadline first, undated last. */
export function listCommitments(db: Db, f: CommitmentFilter = {}): Commitment[] {
  const { parts: where, args, add } = clauses();
  if (f.status) add("c.status = ?", f.status);
  if (f.ownerEntityId) add("c.owner_entity_id = ?", f.ownerEntityId);
  if (f.dueBefore !== undefined) add("c.deadline < ?", f.dueBefore);
  if (f.dueAfter !== undefined) add("c.deadline >= ?", f.dueAfter);
  if (f.documentId) add("c.source_document_id = ?", f.documentId);
  const rows = db
    .prepare(
      `${COMMITMENT_SELECT} ${where.length ? `where ${where.join(" and ")}` : ""}
       order by (c.status in ('open', 'waiting')) desc, c.deadline is null, c.deadline, c.created_at desc
       limit ?`,
    )
    .all(...args, Math.min(f.limit ?? 200, 1000)) as CommitmentRow[];
  return rows.map(toCommitment);
}

export function getCommitment(db: Db, id: string): Commitment {
  const row = db.prepare(`${COMMITMENT_SELECT} where c.id = ?`).get(id) as
    | CommitmentRow
    | undefined;
  if (!row) throw new NotFound("commitment not found");
  return toCommitment(row);
}

/** User edits mark the row `user_edited`, so re-running extraction never overwrites them. */
export function updateCommitment(db: Db, id: string, patch: CommitmentPatch): Commitment {
  db.transaction(() => {
    getCommitment(db, id);
    if (
      patch.ownerEntityId &&
      !db.prepare("select 1 from entities where id = ?").get(patch.ownerEntityId)
    )
      throw new NotFound("owner entity not found");
    const { parts: sets, args, add } = clauses();
    add("updated_at = ?", Date.now());
    sets.push("user_edited = 1");
    if (patch.text !== undefined) add("text = ?", patch.text);
    if (patch.status !== undefined) add("status = ?", patch.status);
    if (patch.ownerEntityId !== undefined) add("owner_entity_id = ?", patch.ownerEntityId);
    if (patch.deadline !== undefined) add("deadline = ?", patch.deadline);
    db.prepare(`update commitments set ${sets.join(", ")} where id = ?`).run(...args, id);
    appendAudit(db, {
      eventType: "commitment_edited",
      actor: "user",
      subjectType: "commitment",
      subjectId: id,
      meta: { fields: Object.keys(patch) },
    });
  })();
  return getCommitment(db, id);
}

export function createCommitment(db: Db, input: CommitmentCreate): Commitment {
  if (!db.prepare("select 1 from documents where id = ?").get(input.documentId))
    throw new NotFound("document not found");
  const id = ulid();
  const now = Date.now();
  db.prepare(
    `insert into commitments (id, text, owner_entity_id, deadline, status, source_document_id, anchor,
     evidence_quote, confidence, user_edited, created_at, updated_at) values (?, ?, ?, ?, 'open', ?, ?, ?, null, 1, ?, ?)`,
  ).run(
    id,
    input.text,
    input.ownerEntityId ?? null,
    input.deadline ?? null,
    input.documentId,
    JSON.stringify(input.anchor ?? { kind: "text" }),
    input.evidenceQuote ?? "",
    now,
    now,
  );
  return getCommitment(db, id);
}

export function listDecisions(
  db: Db,
  f: {
    q?: string | undefined;
    ownerEntityId?: string | undefined;
    documentId?: string | undefined;
  } = {},
): Decision[] {
  const { parts: where, args, add } = clauses();
  if (f.q) add("x.text like ?", `%${f.q}%`);
  if (f.ownerEntityId) add("x.owner_entity_id = ?", f.ownerEntityId);
  if (f.documentId) add("x.source_document_id = ?", f.documentId);
  const rows = db
    .prepare(
      `select x.*, o.display_name as owner_name, d.title as document_title, m.id as meeting_id
       from decisions x join documents d on d.id = x.source_document_id
       left join entities o on o.id = x.owner_entity_id
       left join meetings m on m.document_id = x.source_document_id
       ${where.length ? `where ${where.join(" and ")}` : ""}
       order by x.decided_at desc limit 500`,
    )
    .all(...args) as {
    id: string;
    text: string;
    owner_entity_id: string | null;
    owner_name: string | null;
    decided_at: number | null;
    source_document_id: string;
    document_title: string;
    meeting_id: string | null;
    anchor: string;
    evidence_quote: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    ownerEntityId: r.owner_entity_id,
    ownerName: r.owner_name,
    decidedAt: r.decided_at,
    documentId: r.source_document_id,
    documentTitle: r.document_title,
    meetingId: r.meeting_id,
    anchor: parseAnchor(r.anchor),
    evidenceQuote: r.evidence_quote,
  }));
}

export function getMeetingDetail(db: Db, id: string): MeetingDetail {
  const meeting = getMeeting(db, id);
  const row = getMeetingRow(db, id);
  return {
    meeting,
    segments: meetingSegments(db, id),
    summary: row?.summary ? (JSON.parse(row.summary) as StoredSummary) : null,
    commitments: listCommitments(db, { documentId: meeting.documentId }),
    decisions: listDecisions(db, { documentId: meeting.documentId }),
  };
}

/**
 * Re-runs the failed step: understanding when there is a transcript, else transcription (which
 * needs the recording WAVs or the imported file to still exist).
 */
export function retryMeeting(
  db: Db,
  id: string,
  recExists: (id: string) => boolean,
): { jobId: string } {
  const m = getMeetingRow(db, id);
  if (!m) throw new NotFound("meeting not found");
  if (m.transcription_status !== "failed")
    throw Object.assign(new Error("Only a failed meeting can be retried"), {
      code: "ILLEGAL_TRANSITION",
    });
  const hasSegments = db
    .prepare("select 1 from transcript_segments where meeting_id = ? limit 1")
    .get(id);
  const canTranscribe = m.source === "import" ? Boolean(m.audio_blob) : recExists(id);
  if (!hasSegments && !canTranscribe)
    throw Object.assign(
      new Error("The recording files are gone; this meeting cannot be transcribed again."),
      {
        code: "ILLEGAL_TRANSITION",
      },
    );
  return db.transaction(() => {
    const type = hasSegments ? UNDERSTAND_JOB : TRANSCRIBE_JOB;
    const jobId = enqueue(
      db,
      type,
      { meetingId: id, documentId: m.document_id },
      { heavy: true, priority: 2, maxAttempts: 2 },
    );
    setMeetingStatus(db, id, hasSegments ? "understanding" : "queued", { jobId, error: null });
    return { jobId };
  })();
}

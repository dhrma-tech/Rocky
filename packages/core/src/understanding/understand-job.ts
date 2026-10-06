import type { Channel, ExtractedEntity, PathInfo, StoredSummary } from "@rocky/contracts";
import { ulid } from "ulid";
import { getMeetingRow, setMeetingStatus } from "../capture/meetings.ts";
import { resolveEntity, userEntityId } from "../entities/entities.ts";
import { type Job, setJobProgress } from "../jobs/queue.ts";
import type { Router } from "../router/router.ts";
import type { Db } from "../store/db.ts";
import { tokenJaccard } from "../text/similarity.ts";
import {
  buildWindows,
  extractWindow,
  type MeetingContext,
  parseDeadline,
  type Seg,
  segLine,
  summarizeMeeting,
  type ValidCommitment,
  type ValidDecision,
  WINDOW_CHARS,
} from "./extract.ts";

export const COMMITMENT_DEDUP_JACCARD = 0.7;
const AUTO_TITLE = /^(Meeting|Lecture) \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const UNKNOWN_OWNER = /^(unknown|someone|nobody|n\/a|none|others?|speaker \d*)$/i;

export interface UnderstandDeps {
  db: Db;
  router: Router;
}

export interface UnderstandReport {
  commitments: number;
  decisions: number;
  entities: number;
  dropped: number;
  windows: number;
}

const dayOf = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));

/** Same owner + Jaccard(text) > 0.7 + same deadline day (assistant.md "Dedup"). */
export function isDuplicateCommitment(
  a: { ownerId: string | null; text: string; deadline: number | null },
  b: { ownerId: string | null; text: string; deadline: number | null },
): boolean {
  return (
    a.ownerId === b.ownerId &&
    dayOf(a.deadline) === dayOf(b.deadline) &&
    tokenJaccard(a.text, b.text) > COMMITMENT_DEDUP_JACCARD
  );
}

function loadSegments(db: Db, meetingId: string): Seg[] {
  const rows = db
    .prepare(
      `select start_ms, end_ms, channel, speaker_label, text from transcript_segments
       where meeting_id = ? order by start_ms, end_ms`,
    )
    .all(meetingId) as {
    start_ms: number;
    end_ms: number;
    channel: Channel;
    speaker_label: string | null;
    text: string;
  }[];
  return rows.map((r, i) => ({
    ref: `s${i + 1}`,
    startMs: r.start_ms,
    endMs: r.end_ms,
    channel: r.channel,
    speakerLabel: r.speaker_label ?? "",
    text: r.text,
  }));
}

/**
 * Resolves an extracted owner to an entity. "me" from the remote channel is someone else saying
 * "I", so it can't be the user; unknown owners stay null rather than inventing a person.
 */
function ownerId(db: Db, owner: string | null, channel: Channel | null): string | null {
  const name = owner?.trim();
  if (!name || UNKNOWN_OWNER.test(name)) return null;
  const id = resolveEntity(db, { name });
  if (channel === "system" && id === userEntityId(db)) return null;
  return id;
}

/** The `understand` job (assistant.md): extract per window, summarise, then store everything at once. */
export async function understandMeeting(
  deps: UnderstandDeps,
  job: Job,
): Promise<UnderstandReport | null> {
  const { db } = deps;
  const { meetingId } = job.payload as { meetingId: string };
  const m = getMeetingRow(db, meetingId);
  if (!m) return null;
  setMeetingStatus(db, meetingId, "understanding", { jobId: job.id, error: null });
  try {
    return await run(deps, job, m.id);
  } catch (err) {
    const final = job.attempts >= job.maxAttempts;
    const msg = err instanceof Error ? err.message : String(err);
    setMeetingStatus(db, meetingId, final ? "failed" : "understanding", {
      error: `Understanding failed: ${msg}`,
    });
    throw err;
  }
}

async function run(deps: UnderstandDeps, job: Job, meetingId: string): Promise<UnderstandReport> {
  const { db, router } = deps;
  const m = getMeetingRow(db, meetingId);
  if (!m) throw new Error("Meeting was deleted");
  const doc = db.prepare("select local_only from documents where id = ?").get(m.document_id) as
    | { local_only: number }
    | undefined;
  const nb = m.notebook_id
    ? (db.prepare("select local_only from notebooks where id = ?").get(m.notebook_id) as
        | { local_only: number }
        | undefined)
    : undefined;
  const scope = { localOnly: doc?.local_only === 1 || nb?.local_only === 1 };
  const ctx: MeetingContext = {
    title: m.title,
    kind: m.kind,
    startedAt: m.started_at ?? Date.now(),
  };

  const segs = loadSegments(db, meetingId);
  const windows = buildWindows(segs);
  const commitments: ValidCommitment[] = [];
  const decisions: ValidDecision[] = [];
  const entities: ExtractedEntity[] = [];
  const notes: string[] = [];
  let dropped = 0;
  let path: PathInfo | null = null;
  for (const [i, win] of windows.entries()) {
    setJobProgress(
      db,
      job.id,
      i / (windows.length + 1),
      `extracting part ${i + 1} of ${windows.length}`,
    );
    const r = await extractWindow(router, ctx, win, i, windows.length, scope);
    commitments.push(...r.commitments);
    decisions.push(...r.decisions);
    entities.push(...r.entities);
    if (r.notes.trim()) notes.push(r.notes.trim());
    dropped += r.dropped;
    path = r.path;
  }

  setJobProgress(db, job.id, windows.length / (windows.length + 1), "summarising");
  const transcript = segs.map(segLine).join("\n");
  const summary = await summarizeMeeting(
    router,
    ctx,
    transcript.length <= WINDOW_CHARS ? { transcript } : { notes },
    scope,
  );
  path = summary.path;

  return db.transaction((): UnderstandReport => {
    const now = Date.now();
    // Re-runs replace extracted rows but keep anything the user edited.
    db.prepare("delete from commitments where source_document_id = ? and user_edited = 0").run(
      m.document_id,
    );
    db.prepare("delete from decisions where source_document_id = ?").run(m.document_id);
    db.prepare("delete from document_entities where document_id = ?").run(m.document_id);
    const link = db.prepare(
      "insert or ignore into document_entities (document_id, entity_id, role) values (?, ?, ?)",
    );

    let nEntities = 0;
    for (const e of entities) {
      if (e.kind === "person" && UNKNOWN_OWNER.test(e.name.trim())) continue;
      link.run(
        m.document_id,
        resolveEntity(db, { name: e.name, kind: e.kind, email: e.email }),
        "mentioned",
      );
      nEntities++;
    }

    const existing = (
      db
        .prepare(
          `select owner_entity_id as ownerId, text, deadline from commitments
           where status in ('open', 'waiting') or source_document_id = ?`,
        )
        .all(m.document_id) as { ownerId: string | null; text: string; deadline: number | null }[]
    ).slice();
    const insC = db.prepare(
      `insert into commitments (id, text, owner_entity_id, counterparty_entity_id, deadline, deadline_text, status,
       source_document_id, anchor, evidence_quote, confidence, user_edited, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 0, ?, ?)`,
    );
    let nCommitments = 0;
    for (const c of commitments) {
      const owner = ownerId(db, c.owner, c.channel);
      const counterparty = ownerId(db, c.counterparty, null);
      const deadline = parseDeadline(c.deadline, ctx.startedAt + c.anchor.startMs);
      const row = { ownerId: owner, text: c.text, deadline };
      if (existing.some((e) => isDuplicateCommitment(e, row))) continue;
      existing.push(row);
      insC.run(
        ulid(now),
        c.text,
        owner,
        counterparty,
        deadline,
        c.deadline,
        m.document_id,
        JSON.stringify({ kind: "transcript", ...c.anchor }),
        c.evidenceQuote,
        c.confidence,
        now,
        now,
      );
      if (owner) link.run(m.document_id, owner, "owner");
      nCommitments++;
    }

    const insD = db.prepare(
      `insert into decisions (id, text, owner_entity_id, decided_at, source_document_id, anchor, evidence_quote, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const seen: string[] = [];
    for (const d of decisions) {
      if (seen.some((t) => tokenJaccard(t, d.text) > COMMITMENT_DEDUP_JACCARD)) continue;
      seen.push(d.text);
      insD.run(
        ulid(now),
        d.text,
        ownerId(db, d.owner, null),
        ctx.startedAt + d.anchor.startMs,
        m.document_id,
        JSON.stringify({ kind: "transcript", ...d.anchor }),
        d.evidenceQuote,
        now,
      );
    }

    const stored: StoredSummary = { ...summary.summary, path };
    db.prepare("update meetings set summary = ? where id = ?").run(JSON.stringify(stored), m.id);
    // An auto-generated title ("Meeting 2026-10-06 14:00") is replaced by the model's title.
    if (AUTO_TITLE.test(m.title) && summary.summary.title.trim()) {
      const title = summary.summary.title.trim().slice(0, 200);
      db.prepare("update meetings set title = ? where id = ?").run(title, m.id);
      db.prepare("update documents set title = ? where id = ?").run(title, m.document_id);
    }
    if (m.notebook_id)
      db.prepare(
        "insert or ignore into notebook_sources (notebook_id, document_id, added_by) values (?, ?, 'manual')",
      ).run(m.notebook_id, m.document_id);
    setMeetingStatus(db, m.id, "done", {
      error: dropped
        ? `${dropped} extracted item(s) were dropped: their evidence quote did not match the transcript.`
        : null,
    });
    setJobProgress(db, job.id, 1, "done");
    return {
      commitments: nCommitments,
      decisions: seen.length,
      entities: nEntities,
      dropped,
      windows: windows.length,
    };
  })();
}

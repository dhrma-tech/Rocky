import {
  type ActionRecord,
  type ActionStatus,
  type Citation,
  CitationSchema,
  type Provenance,
  type ReviewLevel,
  type Risk,
} from "@rocky/contracts";
import { ulid } from "ulid";
import { z } from "zod";
import { appendAudit, canonical } from "../audit/append.ts";
import { recordEvent } from "../events/log.ts";
import { LOCAL_CONNECTOR } from "../ingest/upsert.ts";
import { redact } from "../security/redact.ts";
import { sha256 } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";
import { EXECUTORS } from "./internal.ts";
import type { ActionRegistry } from "./registry.ts";
import { ActionError, type PublicActionDefinition } from "./types.ts";

interface Row {
  id: string;
  connector_id: string | null;
  action_type: string;
  payload: string;
  payload_hash: string;
  risk: Risk;
  status: ActionStatus;
  origin: string;
  citations: string;
  idempotency_key: string;
  approved_hash: string | null;
  approved_at: number | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProposeInput {
  type: string;
  payload: unknown;
  origin: string;
  citations: Citation[];
  /** Types implied by the user's own request (classified from user text only). */
  allowedTypes?: string[];
}

const hashPayload = (p: unknown) => sha256(canonical(p));

type ActionChange =
  | "proposed"
  | "edited"
  | "approved"
  | "revoked"
  | "rejected"
  | "executed"
  | "failed";
const ACTION_CHANGES: Record<string, ActionChange> = {
  action_proposed: "proposed",
  action_edited: "edited",
  action_approved: "approved",
  action_revoked: "revoked",
  action_rejected: "rejected",
  action_executed: "executed",
  action_failed: "failed",
};

/**
 * Sources the user wrote themselves: local notes and their own recordings. Everything else (mail,
 * chat, web pages, PDFs, synced apps) is external, and a proposal citing it gets strict review
 * (roadmap I1, docs/DECISIONS.md D-024).
 */
const OWN_SOURCE_TYPES = new Set(["markdown", "text", "meeting", "transcript"]);

/** Provenance of the cited sources and the review level it implies. */
export function provenanceOf(
  db: Db,
  citations: Citation[],
): { provenance: Provenance[]; review: ReviewLevel } {
  const ids = [...new Set(citations.map((c) => c.documentId))];
  if (!ids.length) return { provenance: [], review: "standard" };
  const rows = db
    .prepare(
      `select id, title, source_type, connector_id, meta, suspicious from documents where id in (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as {
    id: string;
    title: string;
    source_type: string;
    connector_id: string | null;
    meta: string;
    suspicious: number;
  }[];
  const provenance = rows.map((r): Provenance => {
    let flags: string[] = [];
    try {
      const f = (JSON.parse(r.meta) as { flags?: unknown }).flags;
      if (Array.isArray(f)) flags = f.filter((x): x is string => typeof x === "string");
    } catch {
      // unreadable meta: no flags
    }
    if (r.suspicious === 1 && !flags.length) flags = ["contains instruction-like text"];
    return {
      documentId: r.id,
      title: r.title,
      sourceType: r.source_type,
      connectorId: r.connector_id,
      external: !(r.connector_id === LOCAL_CONNECTOR && OWN_SOURCE_TYPES.has(r.source_type)),
      flags,
    };
  });
  // A cited document that no longer exists can't be checked: treat it as external.
  const missing = ids.length > rows.length;
  const review: ReviewLevel =
    missing || provenance.some((p) => p.external || p.flags.length) ? "strict" : "standard";
  return { provenance, review };
}
const EXECUTE_TIMEOUT_MS = 120_000;

/**
 * The approval queue (specs/actions.md) and the only code that may run an executor
 * (non-negotiable #1). Approval binds to sha256(canonical(payload)); execute re-checks it.
 */
export class ActionService {
  private readonly db: Db;
  private readonly registry: ActionRegistry;
  private readonly now: () => number;

  constructor(db: Db, registry: ActionRegistry, opts: { now?: () => number } = {}) {
    this.db = db;
    this.registry = registry;
    this.now = opts.now ?? Date.now;
  }

  private def(type: string): PublicActionDefinition {
    const d = this.registry.get(type);
    if (!d) throw new ActionError("UNKNOWN_TYPE", `Unknown action type: ${type}`);
    return d;
  }

  private parse(def: PublicActionDefinition, payload: unknown): unknown {
    const r = def.schema.safeParse(payload);
    if (!r.success)
      throw new ActionError(
        "INVALID_PAYLOAD",
        `Invalid ${def.type} payload: ${z.prettifyError(r.error)}`,
      );
    return r.data;
  }

  private riskOf(def: PublicActionDefinition, payload: unknown): Risk {
    return typeof def.risk === "function" ? def.risk(payload) : def.risk;
  }

  private row(id: string): Row {
    const r = this.db.prepare("select * from actions_queue where id = ?").get(id) as
      | Row
      | undefined;
    if (!r) throw new ActionError("NOT_FOUND", `No action ${id}`);
    return r;
  }

  private audit(
    eventType: string,
    actor: "user" | "routine" | "system",
    id: string,
    extra: {
      payload?: unknown;
      meta?: Record<string, unknown>;
    } = {},
  ) {
    appendAudit(this.db, {
      eventType,
      actor,
      subjectType: "action",
      subjectId: id,
      at: this.now(),
      ...extra,
    });
    this.emit(eventType, id, extra.meta);
  }

  /** The UI event for an action transition (typed event stream), in the same transaction. */
  private emit(eventType: string, id: string, meta?: Record<string, unknown>) {
    const change = ACTION_CHANGES[eventType];
    if (!change) return;
    const a = this.get(id);
    const at = this.now();
    recordEvent(this.db, {
      kind: "approval",
      runId: id,
      at,
      actionId: id,
      change,
      title: a.description.summary ? `${a.title}: ${a.description.summary}` : a.title,
      risk: a.risk,
      review: a.review,
    });
    if (change === "executed")
      recordEvent(this.db, {
        kind: "receipt",
        runId: id,
        at,
        tool: a.connectorId ?? "Rocky",
        verb: a.title,
        count: 1,
        unit: "action",
        // Drafts are the only way Rocky touches mail (non-negotiable #1).
        ...(a.type.includes("draft") ? { notDone: "not sent" } : {}),
        subject: { type: "action", id },
      });
    if (change === "failed")
      recordEvent(this.db, {
        kind: "error",
        runId: id,
        at,
        code: "ACTION_FAILED",
        message: typeof meta?.error === "string" ? meta.error : "The action failed.",
        tried: "Ran the approved payload once.",
        youCan: "Retry it as a new draft, or edit and approve again.",
      });
  }

  propose(input: ProposeInput): ActionRecord {
    const routine = input.origin.startsWith("routine:");
    // Ingest, extraction and other system steps never create proposals (specs/actions.md).
    if (input.origin !== "user_turn" && !routine)
      throw new ActionError("ORIGIN_FORBIDDEN", `Origin "${input.origin}" cannot propose actions`);
    const def = this.def(input.type);
    if (input.allowedTypes && !input.allowedTypes.includes(input.type)) {
      appendAudit(this.db, {
        eventType: "action_dropped",
        actor: "system",
        at: this.now(),
        meta: { type: input.type, origin: input.origin, reason: "type_not_allowed" },
      });
      throw new ActionError(
        "TYPE_NOT_ALLOWED",
        `${input.type} is not an action this request asked for`,
      );
    }
    const citations = z.array(CitationSchema).safeParse(input.citations);
    if (!citations.success || citations.data.length === 0)
      throw new ActionError("NO_CITATION", "A proposal must cite the source that motivated it");
    const payload = this.parse(def, input.payload);
    const now = this.now();
    const id = ulid();
    this.db.transaction(() => {
      this.db
        .prepare(
          `insert into actions_queue (id, connector_id, action_type, payload, payload_hash, risk, status, origin,
             citations, idempotency_key, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          def.connectorId ?? null,
          def.type,
          canonical(payload),
          hashPayload(payload),
          this.riskOf(def, payload),
          input.origin,
          JSON.stringify(citations.data),
          ulid(),
          now,
          now,
        );
      this.audit("action_proposed", routine ? "routine" : "user", id, {
        payload,
        meta: { type: def.type, origin: input.origin },
      });
    })();
    return this.get(id);
  }

  /** Editing keeps the action a draft; the hash changes, so any earlier approval can't apply. */
  edit(id: string, payload: unknown): ActionRecord {
    const r = this.row(id);
    if (r.status !== "draft")
      throw new ActionError(
        "ILLEGAL_TRANSITION",
        `Only drafts can be edited (status: ${r.status})`,
      );
    const def = this.def(r.action_type);
    const p = this.parse(def, payload);
    this.db.transaction(() => {
      this.db
        .prepare(
          "update actions_queue set payload = ?, payload_hash = ?, risk = ?, updated_at = ? where id = ? and status = 'draft'",
        )
        .run(canonical(p), hashPayload(p), this.riskOf(def, p), this.now(), id);
      this.audit("action_edited", "user", id, { payload: p });
    })();
    return this.get(id);
  }

  /**
   * The UI sends the hash of the payload it displayed; it must match the current payload. When
   * external or flagged text motivated the action, the user must also acknowledge its sources.
   */
  approve(
    id: string,
    payloadHash: string,
    opts: { acknowledgeSources?: boolean } = {},
  ): ActionRecord {
    const r = this.row(id);
    if (r.status !== "draft")
      throw new ActionError(
        "ILLEGAL_TRANSITION",
        `Only drafts can be approved (status: ${r.status})`,
      );
    if (payloadHash !== r.payload_hash)
      throw new ActionError(
        "HASH_MISMATCH",
        "The action changed since you viewed it. Review it again before approving.",
      );
    const { review } = provenanceOf(this.db, JSON.parse(r.citations) as Citation[]);
    if (review === "strict" && !opts.acknowledgeSources)
      throw new ActionError(
        "REVIEW_REQUIRED",
        "This action was drafted from text someone else may have written. Check its sources, then confirm.",
      );
    this.db.transaction(() => {
      const n = this.db
        .prepare(
          `update actions_queue set status = 'approved', approved_hash = ?, approved_at = ?, updated_at = ?
           where id = ? and status = 'draft' and payload_hash = ?`,
        )
        .run(payloadHash, this.now(), this.now(), id, payloadHash).changes;
      if (n !== 1) throw new ActionError("HASH_MISMATCH", "The action changed while approving.");
      this.audit("action_approved", "user", id, { meta: { payloadHash, review } });
    })();
    return this.get(id);
  }

  revoke(id: string): ActionRecord {
    this.transition(id, "approved", "draft", "action_revoked", {
      approved_hash: null,
      approved_at: null,
    });
    return this.get(id);
  }

  reject(id: string): ActionRecord {
    this.transition(id, "draft", "rejected", "action_rejected");
    return this.get(id);
  }

  /** A failed action is never retried automatically; the user clones it into a new draft. */
  clone(id: string): ActionRecord {
    const r = this.row(id);
    if (r.status !== "failed")
      throw new ActionError(
        "ILLEGAL_TRANSITION",
        `Only failed actions can be cloned (status: ${r.status})`,
      );
    return this.propose({
      type: r.action_type,
      payload: JSON.parse(r.payload),
      origin: "user_turn",
      citations: JSON.parse(r.citations),
    });
  }

  private transition(
    id: string,
    from: ActionStatus,
    to: ActionStatus,
    event: string,
    extra: Record<string, null> = {},
  ) {
    const r = this.row(id);
    if (r.status !== from)
      throw new ActionError("ILLEGAL_TRANSITION", `Cannot go from ${r.status} to ${to}`);
    const sets = Object.keys(extra)
      .map((k) => `, ${k} = null`)
      .join("");
    this.db.transaction(() => {
      const n = this.db
        .prepare(
          `update actions_queue set status = ?, updated_at = ?${sets} where id = ? and status = ?`,
        )
        .run(to, this.now(), id, from).changes;
      if (n !== 1)
        throw new ActionError("ILLEGAL_TRANSITION", `Cannot go from ${r.status} to ${to}`);
      this.audit(event, "user", id);
    })();
  }

  /**
   * Runs an approved action exactly once. The stored payload is re-hashed and re-validated; the
   * status flip to `executing` is a single conditional UPDATE, so concurrent calls can't both run.
   */
  async execute(id: string): Promise<ActionRecord> {
    const r = this.row(id);
    if (r.status !== "approved" || !r.approved_hash)
      throw new ActionError(
        "ILLEGAL_TRANSITION",
        `Only approved actions can run (status: ${r.status})`,
      );
    const stored: unknown = JSON.parse(r.payload);
    if (hashPayload(stored) !== r.approved_hash || r.payload_hash !== r.approved_hash)
      throw new ActionError("HASH_MISMATCH", "The payload no longer matches what was approved.");
    const def = this.def(r.action_type);
    const payload = this.parse(def, stored);
    const claimed = this.db
      .prepare(
        "update actions_queue set status = 'executing', updated_at = ? where id = ? and status = 'approved' and approved_hash = ?",
      )
      .run(this.now(), id, r.approved_hash).changes;
    if (claimed !== 1)
      throw new ActionError("ILLEGAL_TRANSITION", "This action is already running.");

    const executor = EXECUTORS.get(this.registry)?.get(r.action_type);
    try {
      if (!executor) throw new Error(`No executor for ${r.action_type}`);
      const result = await executor(payload, {
        idempotencyKey: r.idempotency_key,
        signal: AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
      });
      this.db.transaction(() => {
        this.db
          .prepare(
            "update actions_queue set status = 'executed', result = ?, updated_at = ? where id = ?",
          )
          .run(JSON.stringify(result ?? null), this.now(), id);
        this.audit("action_executed", "user", id, { payload: result ?? null });
      })();
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : String(err)).slice(0, 2000);
      this.db.transaction(() => {
        this.db
          .prepare(
            "update actions_queue set status = 'failed', error = ?, updated_at = ? where id = ?",
          )
          .run(msg, this.now(), id);
        this.audit("action_failed", "user", id, { meta: { error: msg } });
      })();
    }
    return this.get(id);
  }

  get(id: string): ActionRecord {
    return this.toRecord(this.row(id));
  }

  list(status?: ActionStatus): ActionRecord[] {
    const rows = (
      status
        ? this.db
            .prepare("select * from actions_queue where status = ? order by created_at desc")
            .all(status)
        : this.db.prepare("select * from actions_queue order by created_at desc").all()
    ) as Row[];
    return rows.map((r) => this.toRecord(r));
  }

  private toRecord(r: Row): ActionRecord {
    const payload: unknown = JSON.parse(r.payload);
    const citations = JSON.parse(r.citations) as Citation[];
    const def = this.registry.get(r.action_type);
    let description = { target: r.action_type, summary: "" };
    try {
      if (def) description = def.describe(payload);
    } catch {
      // A payload the definition can't describe still shows raw in the card.
    }
    const { provenance, review } = provenanceOf(this.db, citations);
    const suspicious = provenance.some((p) => p.flags.length > 0);
    return {
      id: r.id,
      type: r.action_type,
      title: def?.title ?? r.action_type,
      connectorId: r.connector_id,
      payload,
      payloadHash: r.payload_hash,
      risk: r.risk,
      status: r.status,
      origin: r.origin,
      citations,
      suspicious,
      provenance,
      review,
      description,
      idempotencyKey: r.idempotency_key,
      approvedAt: r.approved_at,
      result: r.result === null ? null : (JSON.parse(r.result) as unknown),
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

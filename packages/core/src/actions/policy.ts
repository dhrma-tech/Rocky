import {
  type ActionClass,
  type ActionRule,
  ALWAYS_ASK_CLASSES,
  MAX_GRANT_MS,
  type ReviewLevel,
  type RuleConstraint,
  type RuleCreate,
  RuleCreateSchema,
  type RulePreview,
} from "@rocky/contracts";
import { ulid } from "ulid";
import { z } from "zod";
import { appendAudit } from "../audit/append.ts";
import type { Db } from "../store/db.ts";
import type { ActionRegistry } from "./registry.ts";

/**
 * Rules and grants (roadmap A4). A rule matches proposals by connector, action type or class and
 * payload constraints, and resolves to allow, ask or block. Invariants:
 * - ask first wins: block beats ask beats allow;
 * - allow needs a specific action type, at least one payload constraint and an expiry (X4);
 * - allow never applies to send, spend or delete, to strict-review proposals (I1), or to
 *   anything not proposed from a user turn or a user-enabled routine;
 * - a rule-approved action is approved by its exact payload hash and audited like a click.
 */

interface Row {
  id: string;
  effect: "allow" | "ask" | "block";
  connector_id: string | null;
  action_type: string | null;
  action_class: ActionClass | null;
  constraints: string;
  expires_at: number | null;
  uses_left: number | null;
  from_action_id: string | null;
  note: string;
  created_at: number;
  revoked_at: number | null;
}

export interface ProposalFacts {
  connectorId: string | null;
  type: string;
  actionClass: ActionClass;
  payload: unknown;
  review: ReviewLevel;
  origin: string;
}

export type Decision =
  | { effect: "allow"; ruleId: string }
  | { effect: "ask"; ruleId: string | null; reason: string }
  | { effect: "block"; ruleId: string }
  | { effect: "none" };

const LOOKBACK_MS = 90 * 86_400_000;

function at(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const EMAIL_RE = /[^\s<>"',;]+@([a-z0-9.-]+\.[a-z]{2,})/gi;

/** Every email domain in a value: a string, a list, or objects with an `email` field. */
function domains(v: unknown): string[] {
  const out: string[] = [];
  const visit = (x: unknown) => {
    if (typeof x === "string")
      for (const m of x.matchAll(EMAIL_RE)) out.push((m[1] ?? "").toLowerCase());
    else if (Array.isArray(x)) x.forEach(visit);
    else if (x && typeof x === "object" && "email" in x) visit((x as { email: unknown }).email);
  };
  visit(v);
  return out;
}

export function constraintHolds(c: RuleConstraint, payload: unknown): boolean {
  const v = at(payload, c.field);
  switch (c.op) {
    case "equals":
      return v === c.value;
    case "oneOf": {
      const allowed = c.value as unknown[];
      if (Array.isArray(v)) return v.length > 0 && v.every((x) => allowed.includes(x));
      return allowed.includes(v);
    }
    case "domainIn": {
      const ds = domains(v);
      const ok = c.value.map((d) => d.toLowerCase());
      return ds.length > 0 && ds.every((d) => ok.includes(d));
    }
    case "lte":
      return typeof v === "number" && v <= c.value;
  }
}

export class RuleStore {
  private readonly db: Db;
  private readonly registry: ActionRegistry;
  private readonly now: () => number;

  constructor(db: Db, registry: ActionRegistry, opts: { now?: () => number } = {}) {
    this.db = db;
    this.registry = registry;
    this.now = opts.now ?? Date.now;
  }

  private rows(): Row[] {
    return this.db.prepare("select * from action_rules order by created_at desc").all() as Row[];
  }

  private isActive(r: Row, now = this.now()): boolean {
    return (
      r.revoked_at === null &&
      (r.expires_at === null || r.expires_at > now) &&
      (r.uses_left === null || r.uses_left > 0)
    );
  }

  private toRule(r: Row): ActionRule {
    const rule = {
      id: r.id,
      effect: r.effect,
      connectorId: r.connector_id,
      actionType: r.action_type,
      actionClass: r.action_class,
      constraints: JSON.parse(r.constraints) as RuleConstraint[],
      expiresAt: r.expires_at,
      usesLeft: r.uses_left,
      fromActionId: r.from_action_id,
      note: r.note,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      active: this.isActive(r),
    };
    return { ...rule, sentence: this.sentence(rule) };
  }

  list(): ActionRule[] {
    return this.rows().map((r) => this.toRule(r));
  }

  get(id: string): ActionRule | null {
    const r = this.db.prepare("select * from action_rules where id = ?").get(id) as Row | undefined;
    return r ? this.toRule(r) : null;
  }

  private matches(
    r: Pick<ActionRule, "connectorId" | "actionType" | "actionClass" | "constraints">,
    f: Pick<ProposalFacts, "connectorId" | "type" | "actionClass" | "payload">,
  ): boolean {
    return (
      (r.connectorId === null || r.connectorId === f.connectorId) &&
      (r.actionType === null || r.actionType === f.type) &&
      (r.actionClass === null || r.actionClass === f.actionClass) &&
      r.constraints.every((c) => constraintHolds(c, f.payload))
    );
  }

  /** What the rules say about a proposal. "none" means no rule matched: the user is asked. */
  decide(f: ProposalFacts): Decision {
    const now = this.now();
    const hits = this.rows()
      .filter((r) => this.isActive(r, now))
      .map((r) => this.toRule(r))
      .filter((r) => this.matches(r, f));
    const block = hits.find((r) => r.effect === "block");
    if (block) return { effect: "block", ruleId: block.id };
    const ask = hits.find((r) => r.effect === "ask");
    if (ask) return { effect: "ask", ruleId: ask.id, reason: "a rule says to ask" };
    // Soonest-expiring grant first, so a one-off grant is used before a longer one.
    const allow = hits
      .filter((r) => r.effect === "allow")
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))[0];
    if (!allow) return { effect: "none" };
    if (ALWAYS_ASK_CLASSES.includes(f.actionClass))
      return { effect: "ask", ruleId: allow.id, reason: `it ${f.actionClass}s` };
    if (f.review === "strict")
      return { effect: "ask", ruleId: allow.id, reason: "it was drafted from external text" };
    if (f.origin !== "user_turn" && !f.origin.startsWith("routine:"))
      return { effect: "ask", ruleId: allow.id, reason: "it did not come from you or a routine" };
    return { effect: "allow", ruleId: allow.id };
  }

  /** One use of a grant. Runs inside the approving transaction. */
  consume(id: string): void {
    this.db
      .prepare("update action_rules set uses_left = uses_left - 1 where id = ? and uses_left > 0")
      .run(id);
  }

  problems(input: RuleCreate): string[] {
    const parsed = RuleCreateSchema.safeParse(input);
    if (!parsed.success) return [z.prettifyError(parsed.error)];
    const r = parsed.data;
    const out: string[] = [];
    if (r.actionType && !this.registry.get(r.actionType))
      out.push(`No connector you have added offers ${r.actionType}.`);
    if (r.effect === "allow") {
      if (!r.actionType) out.push("An allow rule names one kind of action.");
      if (!r.constraints.length)
        out.push("An allow rule needs at least one condition on what the action contains.");
      if (r.expiresAt === null) out.push("An allow rule needs an end date.");
      else if (r.expiresAt <= this.now()) out.push("The end date is in the past.");
      else if (r.expiresAt > this.now() + MAX_GRANT_MS)
        out.push("An allow rule can last at most 90 days.");
      if (r.actionClass && ALWAYS_ASK_CLASSES.includes(r.actionClass))
        out.push(`Rocky always asks before an action that ${r.actionClass}s.`);
    }
    return out;
  }

  preview(input: RuleCreate): RulePreview {
    const problems = this.problems(input);
    const parsed = RuleCreateSchema.safeParse(input);
    if (!parsed.success) return { sentence: "", wouldHaveSkipped: 0, problems };
    const r = parsed.data;
    let wouldHaveSkipped = 0;
    if (r.effect === "allow") {
      const past = this.db
        .prepare(
          `select connector_id, action_type, payload from actions_queue
           where status in ('approved', 'executing', 'executed', 'failed') and approved_by_rule is null
             and created_at > ?`,
        )
        .all(this.now() - LOOKBACK_MS) as {
        connector_id: string | null;
        action_type: string;
        payload: string;
      }[];
      wouldHaveSkipped = past.filter((a) => {
        const payload = JSON.parse(a.payload) as unknown;
        return this.matches(r, {
          connectorId: a.connector_id,
          type: a.action_type,
          actionClass: this.classOf(a.action_type, payload),
          payload,
        });
      }).length;
    }
    return { sentence: this.sentence(r), wouldHaveSkipped, problems };
  }

  create(input: RuleCreate): ActionRule {
    const problems = this.problems(input);
    if (problems.length)
      throw Object.assign(new Error(problems.join(" ")), { code: "INVALID_RULE" });
    const r = RuleCreateSchema.parse(input);
    const id = ulid();
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `insert into action_rules (id, effect, connector_id, action_type, action_class, constraints,
             expires_at, uses_left, from_action_id, note, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          r.effect,
          r.connectorId,
          r.actionType,
          r.actionClass,
          JSON.stringify(r.constraints),
          r.expiresAt,
          r.usesLeft,
          r.fromActionId,
          r.note,
          now,
        );
      appendAudit(this.db, {
        eventType: "rule_created",
        actor: "user",
        subjectType: "rule",
        subjectId: id,
        at: now,
        payload: r,
      });
    })();
    return this.get(id) as ActionRule;
  }

  revoke(id: string): ActionRule {
    const now = this.now();
    const n = this.db
      .prepare("update action_rules set revoked_at = ? where id = ? and revoked_at is null")
      .run(now, id).changes;
    if (!n && !this.get(id))
      throw Object.assign(new Error("Rule not found"), { code: "NOT_FOUND" });
    if (n)
      appendAudit(this.db, {
        eventType: "rule_revoked",
        actor: "user",
        subjectType: "rule",
        subjectId: id,
        at: now,
      });
    return this.get(id) as ActionRule;
  }

  classOf(type: string, payload: unknown): ActionClass {
    const def = this.registry.get(type);
    const c = def?.actionClass;
    try {
      return (typeof c === "function" ? c(payload) : c) ?? "write";
    } catch {
      return "write";
    }
  }

  /** The plain-language sentence for a rule (shown before saving and in the list). */
  sentence(
    r: Pick<
      ActionRule,
      | "effect"
      | "connectorId"
      | "actionType"
      | "actionClass"
      | "constraints"
      | "expiresAt"
      | "usesLeft"
    >,
  ): string {
    const title = r.actionType ? (this.registry.get(r.actionType)?.title ?? r.actionType) : null;
    const what = title
      ? lowerFirst(title)
      : r.actionClass
        ? `take actions that ${r.actionClass}`
        : "take any action";
    const where = r.connectorId && !r.actionType ? ` in ${r.connectorId}` : "";
    const when = r.constraints.length
      ? ` when ${r.constraints.map(constraintText).join(" and ")}`
      : "";
    if (r.effect === "block")
      return `Rocky will never ${what}${where}${when}; such proposals are blocked.`;
    if (r.effect === "ask") return `Rocky will always ask before it will ${what}${where}${when}.`;
    const until = [
      r.expiresAt !== null ? `until ${new Date(r.expiresAt).toISOString().slice(0, 10)}` : "",
      r.usesLeft !== null ? `for the next ${r.usesLeft} time${r.usesLeft === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `Rocky will ${what}${where}${when} without asking${until ? `, ${until}` : ""}. It still records each one in the audit log.`;
  }
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function constraintText(c: RuleConstraint): string {
  switch (c.op) {
    case "equals":
      return `${c.field} is ${JSON.stringify(c.value)}`;
    case "oneOf":
      return `${c.field} is one of ${c.value.map((v) => JSON.stringify(v)).join(", ")}`;
    case "domainIn":
      return `every address in ${c.field} is at ${c.value.join(" or ")}`;
    case "lte":
      return `${c.field} is at most ${c.value}`;
  }
}

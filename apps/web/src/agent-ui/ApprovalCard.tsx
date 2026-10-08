import type { ActionRecord } from "@rocky/contracts";
import { ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Banner, Button, Card } from "../ui/index.tsx";
import "./agent-ui.css";
import { Chip } from "./StatusChip.tsx";

/**
 * The approval card (UI spec 17, roadmap M2). Drawn by Rocky's own client code from the
 * structured action, never from text the model wrote about itself, so the model cannot reword its
 * own request. Order: the sentence, what changes, risk, why, policy, payload.
 */

const CLASS_WORD = { write: "Writes", send: "Sends", spend: "Spends", delete: "Deletes" } as const;
const HIGH_CLASSES = new Set(["send", "spend", "delete"]);

type Rec = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
const list = (v: unknown) => (Array.isArray(v) ? v.map(str).join(", ") : str(v));
const when = (v: unknown) => {
  const w = v as { dateTime?: string; date?: string } | undefined;
  const raw = w?.dateTime ?? w?.date;
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return w?.dateTime
    ? d.toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};
const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** The action in one sentence, from the structured payload ("Draft an email to Dana"). */
export function actionSentence(a: ActionRecord): string {
  const p = (a.payload ?? {}) as Rec;
  if (a.type.startsWith("gmail.draft"))
    return `Draft an email to ${list(p.to)}${count(p.cc) ? ` (cc ${count(p.cc)})` : ""}`;
  if (/eventCreate/.test(a.type)) {
    const guests = count(p.attendees);
    return `Create the event “${str(p.summary)}”${guests ? ` with ${guests} guest${guests === 1 ? "" : "s"}` : ""}`;
  }
  if (a.type === "memory.add") return `Remember: “${str(p.fact)}”`;
  if (/eventPatch/.test(a.type)) return `Change the event “${str(p.summary ?? p.eventId)}”`;
  return `${a.title}${a.description.target ? ` in ${a.description.target}` : ""}`;
}

function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="rk-approval__fields">
      {rows
        .filter(([, v]) => v !== "" && v !== null && v !== undefined)
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Per-connector templates for "what will change"; anything else falls back to the fields. */
export function ChangePreview({ a }: { a: ActionRecord }) {
  const p = (a.payload ?? {}) as Rec;
  if (a.type.startsWith("gmail.draft"))
    return (
      <>
        <Fields
          rows={[
            ["To", list(p.to)],
            ["Cc", list(p.cc)],
            ["Subject", str(p.subject)],
            [
              "Body",
              <span key="body0" className="rk-approval__body">
                {str(p.body)}
              </span>,
            ],
          ]}
        />
        <p className="rk-small rk-muted" style={{ margin: 0 }}>
          Saved as a Gmail draft. Rocky never sends email.
        </p>
      </>
    );
  if (a.type === "memory.add")
    return (
      <>
        <Fields
          rows={[
            ["Fact", str(p.fact)],
            ["Saved in", `memory/${str(p.file)}`],
            ["Quote", `“${str(p.quote)}”`],
          ]}
        />
        <p className="rk-small rk-muted" style={{ margin: 0 }}>
          Rocky saves it only if this quote is still in the source. You can edit or forget it in
          Memory.
        </p>
      </>
    );
  if (/eventCreate|eventPatch/.test(a.type))
    return (
      <Fields
        rows={[
          ["Event", str(p.summary)],
          ["Starts", when(p.start)],
          ["Ends", when(p.end)],
          ["Guests", list(p.attendees)],
          [
            "Invitations",
            p.notifyAttendees
              ? "Sent to guests"
              : Array.isArray(p.attendees) && p.attendees.length
                ? "Not sent"
                : "",
          ],
        ]}
      />
    );
  if (/issueCreate|taskCreate|pageCreate|rowCreate/.test(a.type))
    return (
      <Fields
        rows={[
          ["Where", str(p.repo ?? p.project ?? p.teamId ?? p.parentId ?? a.description.target)],
          ["Title", str(p.title ?? p.content ?? p.name)],
          [
            "Details",
            <span key="body1" className="rk-approval__body">
              {str(p.body ?? p.description ?? p.notes)}
            </span>,
          ],
        ]}
      />
    );
  const diff = a.description.diff;
  const source = diff && typeof diff === "object" && !Array.isArray(diff) ? (diff as Rec) : p;
  return <Fields rows={Object.entries(source).map(([k, v]): [string, ReactNode] => [k, str(v)])} />;
}

export interface ApprovalCardProps {
  action: ActionRecord;
  now: number;
  onApprove: (opts: { acknowledgeSources: boolean; holdMs: number }) => void;
  onEdit?: () => void;
  onDeny: () => void;
  onUndo?: () => void;
  onRunNow?: () => void;
  onAlwaysAllow?: () => void;
  onRetry?: () => void;
  /** "Couldn't send your answer" keeps the card open with a retry. */
  answerError?: string | null;
  busy?: boolean;
}

export function ApprovalCard({
  action: a,
  now,
  onApprove,
  onEdit,
  onDeny,
  onUndo,
  onRunNow,
  onAlwaysAllow,
  onRetry,
  answerError,
  busy,
}: ApprovalCardProps) {
  const [checked, setChecked] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const strict = a.review === "strict";
  const highRisk = a.risk === "high" || HIGH_CLASSES.has(a.actionClass);
  const quote = a.citations[0];
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const approve = () => onApprove({ acknowledgeSources: strict && checked, holdMs: 10_000 });
  const held = a.status === "approved" && a.executeAfter !== null && a.executeAfter > now;
  const RiskIcon = a.risk === "high" ? ShieldAlert : ShieldCheck;

  return (
    <Card
      as="article"
      tint={a.status === "draft"}
      className="rk-approval"
      aria-labelledby={`ap-${a.id}`}
    >
      <header className="rk-approval__head">
        <h3 id={`ap-${a.id}`} className="rk-h3" style={{ flex: "1 1 240px" }}>
          {actionSentence(a)}
        </h3>
        <Chip tone={a.risk === "high" ? "warning" : "neutral"} icon={RiskIcon}>
          {CLASS_WORD[a.actionClass]} · {a.risk} risk
        </Chip>
      </header>

      <section aria-label="What will change" className="rk-approval__section">
        <ChangePreview a={a} />
      </section>

      {quote && (
        <p className="rk-approval__why">
          <span className="rk-muted">Why: </span>“{quote.quote}”{" "}
          <span className="rk-muted">— {quote.title}</span>
        </p>
      )}

      <p className="rk-small rk-muted" style={{ margin: 0 }}>
        {a.approvedBy?.kind === "rule"
          ? "Approved by one of your rules. It still waits 10 seconds and is in the audit log."
          : HIGH_CLASSES.has(a.actionClass)
            ? "Rules can't approve actions that send, spend or delete. Rocky always asks."
            : "No rule matched, so Rocky asks."}
      </p>

      {strict && a.status === "draft" && (
        <div className="rk-approval__strict">
          <p style={{ margin: 0 }} className="rk-approval__strict-title">
            <TriangleAlert size={16} strokeWidth={1.5} aria-hidden /> Drafted from text someone else
            may have written
          </p>
          <ul>
            {a.provenance.map((p) => (
              <li key={p.documentId}>
                {p.title}{" "}
                <span className="rk-muted">
                  ({p.sourceType}
                  {p.connectorId ? `, ${p.connectorId}` : ""})
                </span>
                {p.flags.length > 0 && <span> · flagged: {p.flags.join("; ")}</span>}
              </li>
            ))}
          </ul>
          <label className="rk-approval__check">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            I checked where this came from
          </label>
        </div>
      )}

      <details className="rk-approval__payload">
        <summary>Raw payload and hash</summary>
        <pre className="rk-mono">{JSON.stringify(a.payload, null, 2)}</pre>
        <p className="rk-mono rk-muted" style={{ margin: 0, overflowWrap: "anywhere" }}>
          sha256 {a.payloadHash}
        </p>
      </details>

      {answerError && (
        <Banner
          tone="error"
          title="Couldn't send your answer."
          actions={onRetry && <Button onClick={onRetry}>Retry</Button>}
        >
          {answerError}
        </Banner>
      )}

      {a.status === "draft" && !confirming && (
        <div className="rk-approval__actions">
          <Button
            variant="primary"
            disabled={busy || (strict && !checked)}
            onClick={() => (highRisk ? setConfirming(true) : approve())}
          >
            Approve
          </Button>
          {onEdit && <Button onClick={onEdit}>Edit, then approve</Button>}
          <Button variant="tertiary" onClick={onDeny} disabled={busy}>
            Deny
          </Button>
          {onAlwaysAllow && !strict && !HIGH_CLASSES.has(a.actionClass) && (
            <Button variant="tertiary" className="rk-approval__rule" onClick={onAlwaysAllow}>
              Always allow actions like this…
            </Button>
          )}
        </div>
      )}

      {a.status === "draft" && confirming && (
        <section className="rk-approval__confirm" aria-label="Confirm approval">
          <p style={{ margin: 0 }}>
            This {a.actionClass === "write" ? "is high risk" : `${a.actionClass}s outside Rocky`}.
            Approve exactly what is shown above?
          </p>
          <div className="rk-approval__actions">
            <Button ref={confirmRef} variant="primary" disabled={busy} onClick={approve}>
              Yes, approve
            </Button>
            <Button variant="tertiary" onClick={() => setConfirming(false)}>
              Go back
            </Button>
          </div>
        </section>
      )}

      {held && (
        <div className="rk-approval__actions" aria-live="polite">
          <span>Runs in {Math.ceil(((a.executeAfter ?? now) - now) / 1000)} s.</span>
          {onUndo && <Button onClick={onUndo}>Undo</Button>}
          {onRunNow && (
            <Button variant="tertiary" onClick={onRunNow}>
              Run now
            </Button>
          )}
        </div>
      )}

      {a.status !== "draft" && !held && (
        <p className="rk-approval__ended" role="status">
          {a.status === "approved" && "Approved. Waiting to run."}
          {a.status === "executing" && "Running now."}
          {a.status === "executed" && "Done."}
          {a.status === "failed" && `This failed: ${a.error ?? "unknown error"}`}
          {a.status === "rejected" && "Denied, or blocked by a rule. Nothing ran."}
        </p>
      )}
    </Card>
  );
}

import type { ActionRecord } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApprovalCard, actionSentence } from "../agent-ui/ApprovalCard.tsx";
import { useNow } from "../agent-ui/live.tsx";
import { RuleEditor } from "../agent-ui/RuleEditor.tsx";
import { Chip } from "../agent-ui/StatusChip.tsx";
import { api } from "../api.ts";
import { DraftsPanel } from "../components/DraftsPanel.tsx";
import {
  Button,
  Drawer,
  EmptyState,
  ErrorState,
  Skeleton,
  Textarea,
  useKeys,
  useToast,
} from "../ui/index.tsx";
import "./screens.css";

const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const;
const age = (now: number, at: number) => {
  const m = Math.round((now - at) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/**
 * Approvals (UI spec 17): queue on the left, oldest and riskiest first; the card on the right.
 * J and K move through the queue; Enter opens an item and never approves.
 */
export function ApprovalsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const drafts = useQuery({ queryKey: ["actions", "draft"], queryFn: () => api.actions("draft") });
  const held = useQuery({
    queryKey: ["actions", "approved"],
    queryFn: () => api.actions("approved"),
    refetchInterval: 2000,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [denying, setDenying] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<ActionRecord | null>(null);
  const [ruleFor, setRuleFor] = useState<ActionRecord | null>(null);
  const [drafter, setDrafter] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);

  const queue = useMemo(() => {
    const items = [
      ...(held.data?.actions.filter((a) => a.executeAfter !== null) ?? []),
      ...(drafts.data?.actions ?? []),
    ];
    return items.sort(
      (a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.createdAt - b.createdAt,
    );
  }, [drafts.data, held.data]);
  const current = queue.find((a) => a.id === selected) ?? queue[0] ?? null;

  const refresh = () => void qc.invalidateQueries({ queryKey: ["actions"] });
  const act = useMutation({
    mutationFn: async (f: () => Promise<unknown>) => f(),
    onSuccess: () => setAnswerError(null),
    onError: (e) => setAnswerError(e instanceof Error ? e.message : String(e)),
    onSettled: refresh,
  });

  // Move focus with the selection so J/K and screen readers stay together.
  useEffect(() => {
    if (!current) return;
    const i = queue.findIndex((a) => a.id === current.id);
    if (
      document.activeElement &&
      rows.current.includes(document.activeElement as HTMLButtonElement)
    )
      rows.current[i]?.focus();
  }, [current, queue]);

  useKeys((key, e) => {
    const i = queue.findIndex((a) => a.id === current?.id);
    if (key === "j" || key === "k") {
      e.preventDefault();
      const next = queue[key === "j" ? Math.min(i + 1, queue.length - 1) : Math.max(i - 1, 0)];
      setSelected(next?.id ?? null);
      rows.current[queue.findIndex((a) => a.id === next?.id)]?.focus();
    }
  });

  const loading = drafts.isLoading || held.isLoading;
  const failed = drafts.error ?? held.error;

  return (
    <div className="rk-page rk-page--wide">
      <header className="rk-page__head">
        <h1 className="rk-title">Approvals</h1>
        <Button onClick={() => setDrafter(true)}>Draft an email…</Button>
      </header>

      {loading && (
        <div className="rk-split">
          <Skeleton rows={5} height={52} label="Loading approvals" />
          <Skeleton rows={1} height={420} label="Loading the selected approval" />
        </div>
      )}

      {failed && !loading && (
        <ErrorState
          title="Couldn't load the approvals."
          happened={failed.message}
          rockyDid="Nothing was approved or denied."
          fix={
            <Button variant="primary" onClick={refresh}>
              Retry
            </Button>
          }
        />
      )}

      {!loading && !failed && queue.length === 0 && (
        <EmptyState
          headline="Nothing is waiting."
          action={
            <Link to="/ledger" className="rk-button rk-button--secondary">
              Open the ledger
            </Link>
          }
        >
          When Rocky drafts something that would change one of your apps, it waits here for you.
        </EmptyState>
      )}

      {!loading && !failed && current && (
        <div className="rk-split">
          <section aria-label="Queue">
            <p className="rk-small rk-muted" style={{ marginTop: 0 }}>
              {queue.length} waiting · J and K to move
            </p>
            <ul className="rk-queue">
              {queue.map((a, i) => (
                <li key={a.id}>
                  <button
                    type="button"
                    ref={(el) => {
                      rows.current[i] = el;
                    }}
                    className="rk-queue__row"
                    aria-current={a.id === current.id ? "true" : undefined}
                    onClick={() => setSelected(a.id)}
                  >
                    <span className="rk-queue__sentence">{actionSentence(a)}</span>
                    <span className="rk-queue__meta">
                      <Chip tone={a.risk === "high" ? "warning" : "neutral"}>{a.risk} risk</Chip>
                      <span className="rk-small rk-muted">
                        {a.status === "approved"
                          ? "approved, waiting to run"
                          : age(now, a.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="Selected approval">
            <ApprovalCard
              key={`${current.id}-${current.payloadHash}`}
              action={current}
              now={now}
              busy={act.isPending}
              answerError={answerError}
              onRetry={() => setAnswerError(null)}
              onApprove={({ acknowledgeSources, holdMs }) =>
                act.mutate(async () => {
                  await api.approveAction(
                    current.id,
                    current.payloadHash,
                    acknowledgeSources,
                    holdMs,
                  );
                  toast({
                    text: "Approved. It runs in 10 seconds.",
                    action: {
                      label: "Undo",
                      run: () => act.mutate(() => api.revokeAction(current.id)),
                    },
                  });
                })
              }
              onUndo={() => act.mutate(() => api.revokeAction(current.id))}
              onRunNow={() => act.mutate(() => api.executeAction(current.id))}
              onEdit={() => setEditing(current)}
              onDeny={() => {
                setDenying(current.id);
                setNote("");
              }}
              onAlwaysAllow={() => setRuleFor(current)}
            />
            {denying === current.id && (
              <form
                className="rk-card"
                style={{ marginTop: "var(--space-3)", display: "grid", gap: "var(--space-3)" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  act.mutate(() => api.rejectAction(current.id, note || undefined));
                  setDenying(null);
                  toast({ text: "Denied. Nothing ran." });
                }}
              >
                <Textarea
                  label="A note for Rocky (optional)"
                  help="Why not, or what to do instead. Kept with the decision."
                  value={note}
                  maxLength={500}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="rk-approval__actions">
                  <Button type="submit" variant="primary">
                    Deny
                  </Button>
                  <Button variant="tertiary" onClick={() => setDenying(null)}>
                    Keep it
                  </Button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      <Drawer open={editing !== null} onClose={() => setEditing(null)} title="Edit, then approve">
        {editing && (
          <EditPayload
            action={editing}
            onSaved={() => {
              setEditing(null);
              refresh();
              toast({ text: "Saved. Review it again, then approve." });
            }}
          />
        )}
      </Drawer>
      <Drawer
        open={ruleFor !== null}
        onClose={() => setRuleFor(null)}
        title="Always allow actions like this"
      >
        {ruleFor && (
          <RuleEditor
            action={ruleFor}
            onSaved={() => {
              setRuleFor(null);
              toast({ text: "Rule saved. It is listed in Settings, where you can end it." });
            }}
          />
        )}
      </Drawer>
      <Drawer open={drafter} onClose={() => setDrafter(false)} title="Draft an email">
        <DraftsPanel />
      </Drawer>
    </div>
  );
}

/** The fallback editor: the exact payload as JSON. Saving changes the hash, so it needs a new approval. */
function EditPayload({ action, onSaved }: { action: ActionRecord; onSaved: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(action.payload, null, 2));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("That isn't valid JSON yet.");
      }
      return api.editAction(action.id, payload);
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  return (
    <form
      style={{ display: "grid", gap: "var(--space-3)" }}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Textarea
        label="Payload"
        help="Saving changes the payload hash, so it needs a fresh approval."
        className="rk-input rk-mono"
        value={text}
        error={error}
        onChange={(e) => setText(e.target.value)}
        rows={12}
      />
      <div>
        <Button type="submit" variant="primary" loading={save.isPending ? "Saving…" : false}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

import type { Citation, TimelineItem } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApprovalCard } from "../agent-ui/ApprovalCard.tsx";
import { useLive, useNow, useOverallState } from "../agent-ui/live.tsx";
import { Pebble } from "../agent-ui/Pebble.tsx";
import { activeRuns, finishedSince, receiptText } from "../agent-ui/runs.ts";
import { StatusChip } from "../agent-ui/StatusChip.tsx";
import { TaskCard } from "../agent-ui/work.tsx";
import { api, assistant } from "../api.ts";
import { BriefBody } from "../components/BriefPanel.tsx";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { Button, Card, Drawer, EmptyState, Input, Skeleton, useToast } from "../ui/index.tsx";
import "./screens.css";

const SEEN_KEY = "rocky.today.seen";
/** Per-viewer convenience only: when the user last looked at Today (may be unavailable). */
function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || Date.now() - 86_400_000;
  } catch {
    return Date.now() - 86_400_000;
  }
}
function writeSeen(at: number) {
  try {
    localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    // private window or blocked storage: Today still works, it just forgets
  }
}

const STARTERS = [
  "What did we decide this week?",
  "Who owes me a reply?",
  "What is due before Friday?",
];
const time = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * Today (UI spec 4): what needs me, what is running, what finished while I was away. Anything
 * waiting on the user always sits above anything Rocky is doing.
 */
export function TodayPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow();
  const live = useLive();
  const [ask, setAsk] = useState("");
  const [seen, setSeen] = useState(readSeen);
  const [brief, setBrief] = useState<TimelineItem | null>(null);
  const [source, setSource] = useState<Citation | null>(null);
  const drafts = useQuery({ queryKey: ["actions", "draft"], queryFn: () => api.actions("draft") });
  const home = useQuery({ queryKey: ["home"], queryFn: assistant.home, refetchInterval: 60_000 });
  const routines = useQuery({ queryKey: ["routines"], queryFn: assistant.routines });
  const state = useOverallState(drafts.data?.actions.length ?? 0);
  const act = useMutation({
    mutationFn: (f: () => Promise<unknown>) => f(),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["actions"] }),
  });

  const needs = drafts.data?.actions ?? [];
  const running = activeRuns(live.runs);
  const finished = finishedSince(live.runs, seen);
  const nextRoutine = (routines.data?.routines ?? [])
    .filter((r) => r.enabled && r.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
  const due = [...(home.data?.overdue ?? []), ...(home.data?.dueSoon ?? [])].slice(0, 5);
  const go = (q: string) => void navigate({ to: "/ask", search: { q } });
  const loading = drafts.isLoading || live.loading;

  return (
    <div className="rk-page rk-page--wide">
      <header className="rk-page__head">
        <h1 className="rk-title">Today</h1>
        {needs.length > 0 && (
          <Link to="/approvals" className="rk-button rk-button--primary">
            Review ({needs.length})
          </Link>
        )}
      </header>
      <div className="rk-today">
        <div>
          <form
            className="rk-composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (ask.trim()) go(ask.trim());
            }}
          >
            <Input label="Ask Rocky" value={ask} onChange={(e) => setAsk(e.target.value)} />
            <Button type="submit" variant={needs.length ? "secondary" : "primary"}>
              Ask
            </Button>
          </form>

          {loading && (
            <>
              <Skeleton rows={1} height={260} label="Loading what needs you" />
              <div style={{ height: 24 }} />
              <Skeleton rows={2} height={120} label="Loading running tasks" />
            </>
          )}

          {!loading && needs.length > 0 && (
            <section className="rk-section" aria-labelledby="needs">
              <div className="rk-section__head">
                <h2 id="needs" className="rk-h2">
                  Needs you
                </h2>
                {needs.length > 3 && <Link to="/approvals">See all {needs.length}</Link>}
              </div>
              {needs.slice(0, 3).map((a) => (
                <ApprovalCard
                  key={`${a.id}-${a.payloadHash}`}
                  action={a}
                  now={now}
                  busy={act.isPending}
                  onApprove={({ acknowledgeSources, holdMs }) =>
                    act.mutate(async () => {
                      await api.approveAction(a.id, a.payloadHash, acknowledgeSources, holdMs);
                      toast({
                        text: "Approved. It runs in 10 seconds.",
                        action: {
                          label: "Undo",
                          run: () => act.mutate(() => api.revokeAction(a.id)),
                        },
                      });
                    })
                  }
                  onDeny={() =>
                    act.mutate(async () => {
                      await api.rejectAction(a.id);
                      toast({ text: "Denied. Nothing ran." });
                    })
                  }
                />
              ))}
            </section>
          )}

          {!loading && needs.length === 0 && running.length === 0 && (
            <EmptyState
              headline="Nothing needs you."
              action={
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                  {STARTERS.map((s) => (
                    <Button key={s} onClick={() => go(s)}>
                      {s}
                    </Button>
                  ))}
                </div>
              }
            >
              Ask about your meetings, mail and documents. Anything Rocky drafts for you waits here.
            </EmptyState>
          )}

          {!loading && running.length > 0 && (
            <section className="rk-section" aria-labelledby="running">
              <h2 id="running" className="rk-h2">
                Running
              </h2>
              {running.map((r) => (
                <TaskCard
                  key={r.id}
                  run={r}
                  now={now}
                  action={
                    <Link
                      to="/runs/$id"
                      params={{ id: r.id }}
                      className="rk-button rk-button--secondary rk-button--dense"
                    >
                      Open task
                    </Link>
                  }
                />
              ))}
            </section>
          )}

          {!loading && finished.length > 0 && (
            <section className="rk-section" aria-labelledby="finished">
              <div className="rk-section__head">
                <h2 id="finished" className="rk-h2">
                  Finished since you left
                </h2>
                <Button
                  variant="tertiary"
                  onClick={() => {
                    writeSeen(now);
                    setSeen(now);
                  }}
                >
                  Dismiss
                </Button>
              </div>
              <ul className="rk-list">
                {finished.map((r) => (
                  <li key={r.id}>
                    <details className="rk-finished">
                      <summary>
                        <StatusChip state={r.state} />
                        <span>{r.title}</span>
                        <span className="rk-small rk-muted">{time(r.updatedAt)}</span>
                      </summary>
                      <ul className="rk-list" style={{ paddingLeft: "var(--space-6)" }}>
                        {r.receipts.map((x) => (
                          <li key={x.seq} className="rk-small">
                            {receiptText(x)}
                          </li>
                        ))}
                        <li>
                          <Link to="/runs/$id" params={{ id: r.id }}>
                            Open the run
                          </Link>
                        </li>
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="rk-side-col" aria-label="Context">
          <Card>
            <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
              <Pebble state={state} size={40} />
              <div style={{ display: "grid", gap: "var(--space-1)" }}>
                <strong>Rocky</strong>
                {state ? (
                  <StatusChip state={state} />
                ) : (
                  <span className="rk-small rk-muted">At rest</span>
                )}
              </div>
            </div>
            {running[0]?.line && <p className="rk-small">{running[0].line}</p>}
            <Link to="/ledger" className="rk-small">
              Open the ledger
            </Link>
          </Card>

          {(home.data?.today.length ?? 0) > 0 && (
            <Card>
              <h2 className="rk-h3">On your calendar</h2>
              <ul className="rk-list">
                {home.data?.today.map((i) => (
                  <li
                    key={`${i.title}-${i.start}`}
                    style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
                  >
                    <span className="rk-small rk-muted" style={{ minWidth: 48 }}>
                      {i.allDay ? "All day" : time(i.start)}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                      {i.title}
                    </span>
                    {i.kind === "event" && i.documentId && (
                      <Button dense variant="tertiary" onClick={() => setBrief(i)}>
                        Brief me
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {due.length > 0 && (
            <Card>
              <h2 className="rk-h3">Due soon</h2>
              <ul className="rk-list">
                {due.map((c) => (
                  <li key={c.id} className="rk-small">
                    {c.text}
                    {c.deadlineText ? <span className="rk-muted"> · {c.deadlineText}</span> : null}
                  </li>
                ))}
              </ul>
              <Link to="/commitments" className="rk-small">
                All commitments
              </Link>
            </Card>
          )}

          <Card>
            <h2 className="rk-h3">Next routine</h2>
            {nextRoutine ? (
              <p className="rk-small" style={{ margin: 0 }}>
                {nextRoutine.name} · {new Date(nextRoutine.nextRunAt ?? 0).toLocaleString()}
              </p>
            ) : (
              <p className="rk-small rk-muted" style={{ margin: 0 }}>
                None scheduled.
              </p>
            )}
            <Link to="/routines" className="rk-small">
              New routine
            </Link>
          </Card>
        </aside>
      </div>

      <Drawer
        open={brief !== null}
        onClose={() => setBrief(null)}
        title={brief ? `Brief: ${brief.title}` : "Brief"}
      >
        {brief && <BriefBody item={brief} onOpen={setSource} />}
      </Drawer>
      {source && <SourceViewer citation={source} onClose={() => setSource(null)} />}
    </div>
  );
}

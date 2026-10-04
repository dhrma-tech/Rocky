import type { ActionRecord, ActionStatus, AuditRow, Citation, Risk } from "@rocky/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  CircleCheck,
  CircleX,
  ListChecks,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { api } from "../api.ts";
import { SafeText } from "../components/SafeText.tsx";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { CitationChip } from "../components/trust.tsx";
import { Badge, Button, cls } from "../components/ui.tsx";

const RISK: Record<Risk, { tone: "neutral" | "warning" | "danger"; label: string }> = {
  low: { tone: "neutral", label: "Low risk" },
  medium: { tone: "warning", label: "Medium risk" },
  high: { tone: "danger", label: "High risk" },
};

const STATUS_LABEL: Record<ActionStatus, string> = {
  draft: "Waiting for approval",
  approved: "Approved",
  executing: "Running",
  executed: "Done",
  rejected: "Rejected",
  failed: "Failed",
};

const FILTERS: (ActionStatus | "all")[] = [
  "draft",
  "approved",
  "executed",
  "rejected",
  "failed",
  "all",
];

/** Approval card (DESIGN §5.7): the exact payload, risk, sources; nothing runs until approved. */
function ApprovalCard({ a, onOpen }: { a: ActionRecord; onOpen: (c: Citation) => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(a.payload, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["actions"] });

  // Approve sends the hash of the payload shown on this card; execution follows immediately.
  const approve = useMutation({
    mutationFn: async () => {
      await api.approveAction(a.id, a.payloadHash);
      return api.executeAction(a.id);
    },
    onSettled: refresh,
  });
  const reject = useMutation({ mutationFn: () => api.rejectAction(a.id), onSettled: refresh });
  const clone = useMutation({ mutationFn: () => api.cloneAction(a.id), onSettled: refresh });
  const save = useMutation({
    mutationFn: (payload: unknown) => api.editAction(a.id, payload),
    onSuccess: () => setEditing(false),
    onSettled: refresh,
  });
  const error = approve.error ?? reject.error ?? clone.error ?? save.error;
  const risk = RISK[a.risk];

  return (
    <article
      aria-labelledby={`action-${a.id}`}
      className="space-y-4 rounded-lg bg-raised p-4 shadow-raised-sm"
    >
      <header className="flex flex-wrap items-center gap-2">
        <Zap size={18} aria-hidden className="text-accent-strong" />
        <h2 id={`action-${a.id}`} className="text-base font-semibold">
          {a.title}
        </h2>
        <span className="text-sm text-secondary">→ {a.description.target}</span>
        <span className="ml-auto flex gap-2">
          <Badge tone={risk.tone}>
            {a.risk === "high" ? (
              <ShieldAlert size={12} aria-hidden />
            ) : (
              <ShieldCheck size={12} aria-hidden />
            )}
            {risk.label}
          </Badge>
          {a.status !== "draft" && (
            <Badge tone={a.status === "failed" ? "danger" : "neutral"}>
              {STATUS_LABEL[a.status]}
            </Badge>
          )}
        </span>
      </header>

      {a.suspicious && (
        <p
          role="note"
          className="flex items-start gap-2 rounded-md bg-layer-subtle p-3 text-sm text-warning"
        >
          <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />A source behind this
          action contains text that looks like instructions to an AI. Check the payload carefully.
        </p>
      )}

      {a.description.summary && (
        <p className="text-sm text-primary">
          <SafeText text={a.description.summary} />
        </p>
      )}

      {editing ? (
        <div className="space-y-2">
          <label htmlFor={`payload-${a.id}`} className="text-sm font-medium">
            Payload (JSON)
          </label>
          <textarea
            id={`payload-${a.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="w-full rounded-md border border-border-strong bg-sunken p-3 font-mono text-[13px] text-primary"
          />
          {parseError && (
            <p role="alert" className="text-sm text-danger">
              {parseError}
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="sr-only">Exact payload:</p>
          <pre className="max-h-72 overflow-auto rounded-md bg-sunken p-3 font-mono text-[13px] leading-5 text-primary">
            {JSON.stringify(a.payload, null, 2)}
          </pre>
        </>
      )}

      {a.citations.length > 0 && (
        <p className="text-sm text-secondary">
          Because of:
          {a.citations.map((c, i) => (
            <CitationChip key={c.chunkId} index={i + 1} citation={c} onOpen={onOpen} />
          ))}
        </p>
      )}

      {a.status === "failed" && a.error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-danger">
          <CircleX size={16} aria-hidden className="mt-0.5 shrink-0" />
          {a.error}
        </p>
      )}
      {a.status === "executed" && (
        <p className="flex items-center gap-2 text-sm text-success">
          <CircleCheck size={16} aria-hidden /> Done.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}

      {a.status === "draft" && (
        <footer className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <Button
                variant="primary"
                disabled={save.isPending}
                onClick={() => {
                  try {
                    setParseError(null);
                    save.mutate(JSON.parse(draft));
                  } catch {
                    setParseError("That is not valid JSON.");
                  }
                }}
              >
                Save changes
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                disabled={approve.isPending}
                onClick={() => approve.mutate()}
              >
                {approve.isPending ? "Running…" : "Approve"}
              </Button>
              <Button variant="danger" disabled={reject.isPending} onClick={() => reject.mutate()}>
                Reject
              </Button>
              <Button variant="ghost" onClick={() => setEditing(true)}>
                Edit
              </Button>
            </>
          )}
          <span className="ml-auto text-xs text-tertiary">Nothing runs until you approve.</span>
        </footer>
      )}
      {a.status === "failed" && (
        <footer>
          <Button disabled={clone.isPending} onClick={() => clone.mutate()}>
            Retry as a new draft
          </Button>
        </footer>
      )}
    </article>
  );
}

const time = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

function AuditEntry({ e }: { e: AuditRow }) {
  const [open, setOpen] = useState(false);
  const detail = e.payload ?? (Object.keys(e.meta).length ? e.meta : null);
  return (
    <li className="border-t border-border-base">
      <button
        type="button"
        aria-expanded={open}
        disabled={!detail}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-14 w-full items-center gap-3 px-2 text-left text-sm hover:bg-layer-subtle disabled:hover:bg-transparent"
      >
        <span className="tabular w-44 shrink-0 font-mono text-xs text-secondary">{time(e.at)}</span>
        <span className="w-20 shrink-0 text-secondary">
          {e.actor === "user" ? "You" : e.actor === "routine" ? "Routine" : "Rocky"}
        </span>
        <span className="font-medium">{e.eventType.replace(/_/g, " ")}</span>
        {e.subjectId && (
          <span className="truncate font-mono text-xs text-tertiary">{e.subjectId}</span>
        )}
        {detail && (
          <ChevronDown
            size={16}
            aria-hidden
            className={cls(
              "ml-auto shrink-0 transition-transform duration-[180ms]",
              open && "rotate-180",
            )}
          />
        )}
      </button>
      {open && detail && (
        <pre className="mb-2 overflow-auto rounded-md bg-sunken p-3 font-mono text-[13px] text-primary">
          {JSON.stringify(detail, null, 2)}
        </pre>
      )}
      {open && e.payloadHash && !e.payload && (
        <p className="mb-2 px-2 text-xs text-tertiary">
          Payload deleted. Its hash stays in the chain.
        </p>
      )}
    </li>
  );
}

function AuditLog() {
  const q = useInfiniteQuery({
    queryKey: ["audit"],
    queryFn: ({ pageParam }) => api.audit(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const verify = useMutation({ mutationFn: api.verifyAudit });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <section aria-label="Audit log" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-secondary">
          Every model call, approval and deletion, in order. Entries can't be edited or removed.
        </p>
        <Button className="ml-auto" disabled={verify.isPending} onClick={() => verify.mutate()}>
          Verify chain
        </Button>
      </div>
      {verify.data && (
        <p
          role="status"
          className={cls(
            "flex items-center gap-2 text-sm",
            verify.data.ok ? "text-success" : "text-danger",
          )}
        >
          {verify.data.ok ? (
            <CircleCheck size={16} aria-hidden />
          ) : (
            <CircleX size={16} aria-hidden />
          )}
          {verify.data.ok
            ? `Intact: ${verify.data.checked} entries verified.`
            : `Broken at entry ${verify.data.firstBrokenSeq}: ${verify.data.reason}.`}
        </p>
      )}
      {entries.length === 0 && !q.isLoading && (
        <p className="text-sm text-tertiary">No entries yet.</p>
      )}
      <ol className="rounded-lg bg-raised px-2 shadow-raised-sm">
        {entries.map((e) => (
          <AuditEntry key={e.seq} e={e} />
        ))}
      </ol>
      {q.hasNextPage && (
        <Button
          variant="ghost"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Load older entries
        </Button>
      )}
    </section>
  );
}

export function ActionsPage() {
  const [tab, setTab] = useState<"queue" | "audit">("queue");
  const [filter, setFilter] = useState<ActionStatus | "all">("draft");
  const [open, setOpen] = useState<Citation | null>(null);
  const actions = useQuery({
    queryKey: ["actions", filter],
    queryFn: () => api.actions(filter === "all" ? undefined : filter),
  });

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto px-4">
        <div className="mx-auto max-w-[760px] space-y-6 py-8">
          <h1 className="text-2xl font-normal leading-8">Actions</h1>
          <div role="tablist" aria-label="Actions views" className="flex gap-2">
            {(["queue", "audit"] as const).map((t) => (
              <Button
                key={t}
                role="tab"
                aria-selected={tab === t}
                variant={tab === t ? "secondary" : "ghost"}
                onClick={() => setTab(t)}
              >
                {t === "queue" ? "Approval queue" : "Audit log"}
              </Button>
            ))}
          </div>

          {tab === "queue" ? (
            <section aria-label="Approval queue" className="space-y-4">
              <fieldset className="flex flex-wrap gap-2">
                <legend className="sr-only">Filter by status</legend>
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                    className={cls(
                      "h-8 rounded-full px-3 text-xs font-medium transition-colors duration-[180ms]",
                      filter === f
                        ? "bg-accent-soft text-primary"
                        : "bg-layer-subtle text-secondary hover:bg-layer-strong",
                    )}
                  >
                    {f === "all" ? "All" : STATUS_LABEL[f]}
                  </button>
                ))}
              </fieldset>
              {actions.error && (
                <p role="alert" className="text-sm text-danger">
                  {actions.error.message}
                </p>
              )}
              {actions.data?.actions.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-12 text-center text-secondary">
                  <ListChecks size={28} aria-hidden className="text-accent-strong" />
                  <p>
                    Nothing here. Proposed actions appear here and run only after you approve them.
                  </p>
                </div>
              )}
              {actions.data?.actions.map((a) => (
                <ApprovalCard key={`${a.id}-${a.payloadHash}`} a={a} onOpen={setOpen} />
              ))}
            </section>
          ) : (
            <AuditLog />
          )}
        </div>
      </div>
      {open && (
        <div className="fixed inset-0 z-30 lg:static lg:z-auto">
          <SourceViewer citation={open} onClose={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}

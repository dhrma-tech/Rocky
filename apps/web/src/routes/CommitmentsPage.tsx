import type { Citation, Commitment, CommitmentStatus, Decision } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Mic } from "lucide-react";
import { useState } from "react";
import { api } from "../api.ts";
import { clock } from "../components/capture.tsx";
import { SafeText } from "../components/SafeText.tsx";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { cls } from "../components/ui.tsx";

const STATUSES: CommitmentStatus[] = ["open", "waiting", "done", "dropped"];
const STATUS_LABEL: Record<CommitmentStatus, string> = {
  open: "Open",
  waiting: "Waiting",
  done: "Done",
  dropped: "Dropped",
};
const DAY = 86_400_000;

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function relative(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (Math.abs(days) < 14) return rtf.format(days, "day");
  return rtf.format(Math.round(days / 7), "week");
}
const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export const isOverdue = (c: Commitment, now = Date.now()) =>
  c.deadline !== null &&
  (c.status === "open" || c.status === "waiting") &&
  c.deadline < startOfDay(now);

/** Due date: relative + absolute; overdue shows the danger icon and the word (DESIGN screen 6). */
export function DueDate({ c }: { c: Commitment }) {
  if (c.deadline === null)
    return c.deadlineText ? (
      <span title="The stated deadline could not be read as a date.">“{c.deadlineText}”</span>
    ) : (
      <span className="text-tertiary">No due date</span>
    );
  const overdue = isOverdue(c);
  return (
    <span className={cls("inline-flex items-center gap-1", overdue && "text-danger")}>
      {overdue && <CircleAlert size={14} aria-hidden />}
      {overdue && <span className="font-medium">Overdue</span>}
      <span>
        {relative(c.deadline)} ·{" "}
        {new Date(c.deadline).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
      </span>
    </span>
  );
}

function useCommitmentPatch(c: Commitment) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<typeof api.patchCommitment>[1]) =>
      api.patchCommitment(c.id, patch),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["commitments"] });
      void qc.invalidateQueries({ queryKey: ["meeting"] });
    },
  });
}

export function CommitmentStatusSelect({ c }: { c: Commitment }) {
  const patch = useCommitmentPatch(c);
  return (
    <select
      aria-label={`Status of: ${c.text}`}
      value={c.status}
      disabled={patch.isPending}
      onChange={(e) => patch.mutate({ status: e.target.value as CommitmentStatus })}
      className="min-h-9 rounded-md border border-border-base bg-page px-2 text-xs"
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

function OwnerSelect({ c, owners }: { c: Commitment; owners: { id: string; name: string }[] }) {
  const patch = useCommitmentPatch(c);
  return (
    <select
      aria-label={`Owner of: ${c.text}`}
      value={c.ownerEntityId ?? ""}
      disabled={patch.isPending}
      onChange={(e) => patch.mutate({ ownerEntityId: e.target.value || null })}
      className="min-h-9 max-w-40 rounded-md border border-border-base bg-page px-2 text-xs"
    >
      <option value="">Unknown</option>
      {owners.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

function DeadlineInput({ c }: { c: Commitment }) {
  const patch = useCommitmentPatch(c);
  const value = c.deadline === null ? "" : new Date(c.deadline).toLocaleDateString("en-CA");
  return (
    <input
      type="date"
      aria-label={`Due date of: ${c.text}`}
      value={value}
      disabled={patch.isPending}
      onChange={(e) => {
        const v = e.target.value;
        patch.mutate({ deadline: v ? new Date(`${v}T17:00:00`).getTime() : null });
      }}
      className="min-h-9 rounded-md border border-border-base bg-page px-2 text-xs"
    />
  );
}

const toCitation = (x: Commitment | Decision): Citation | null =>
  x.chunkId
    ? {
        chunkId: x.chunkId,
        documentId: x.documentId,
        title: x.documentTitle,
        anchor: x.anchor,
        quote: x.evidenceQuote,
      }
    : null;

function SourceChip({ x, onOpen }: { x: Commitment | Decision; onOpen: (c: Citation) => void }) {
  const c = toCitation(x);
  if (!c) return <span className="text-xs text-tertiary">Manual</span>;
  const where = x.anchor.kind === "transcript" ? ` ${clock(x.anchor.startMs)}` : "";
  return (
    <button
      type="button"
      onClick={() => onOpen(c)}
      title={`“${x.evidenceQuote}”`}
      aria-label={`Open source: ${x.documentTitle}${where}`}
      className="inline-flex h-7 max-w-48 items-center gap-1 rounded-full bg-layer-subtle px-2.5 text-xs font-medium text-secondary hover:bg-layer-strong"
    >
      <Mic size={12} aria-hidden className="shrink-0" />
      <span className="truncate">{x.documentTitle}</span>
      {where && <span className="tabular shrink-0">{where}</span>}
    </button>
  );
}

type Due = "any" | "overdue" | "week" | "none";

/** DESIGN screen 6: Commitments and Decisions tabs; filters; overdue marked; row source in the drawer. */
export function CommitmentsPage() {
  const [tab, setTab] = useState<"commitments" | "decisions">("commitments");
  const [status, setStatus] = useState<CommitmentStatus | "">("open");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState<Due>("any");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Citation | null>(null);

  const commitments = useQuery({
    queryKey: ["commitments", status, owner],
    queryFn: () => api.commitments({ status: status || undefined, owner: owner || undefined }),
    enabled: tab === "commitments",
  });
  const decisions = useQuery({
    queryKey: ["decisions", q],
    queryFn: () => api.decisions(q),
    enabled: tab === "decisions",
  });
  const entities = useQuery({ queryKey: ["entities"], queryFn: () => api.entities() });
  const owners = (entities.data?.entities ?? [])
    .filter((e) => e.kind === "person")
    .map((e) => ({ id: e.id, name: `${e.displayName}${e.unconfirmed ? " (unconfirmed)" : ""}` }));

  const now = Date.now();
  const rows = (commitments.data?.commitments ?? []).filter((c) =>
    due === "overdue"
      ? isOverdue(c, now)
      : due === "week"
        ? c.deadline !== null && c.deadline < now + 7 * DAY
        : due === "none"
          ? c.deadline === null
          : true,
  );

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-8">
          <h1 className="text-2xl font-normal leading-8">Commitments</h1>
          <div
            role="tablist"
            aria-label="View"
            className="mt-6 flex gap-1 border-b border-border-base"
          >
            {(["commitments", "decisions"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cls(
                  "min-h-11 border-b-2 px-4 text-sm",
                  tab === t
                    ? "border-accent-strong font-semibold text-primary"
                    : "border-transparent text-secondary hover:text-primary",
                )}
              >
                {t === "commitments" ? "Commitments" : "Decisions"}
              </button>
            ))}
          </div>

          {tab === "commitments" ? (
            <section aria-label="Commitments" className="mt-4">
              <div className="flex flex-wrap gap-3">
                <Filter
                  label="Status"
                  value={status}
                  onChange={(v) => setStatus(v as CommitmentStatus | "")}
                  options={[
                    ["", "All"],
                    ...STATUSES.map((s) => [s, STATUS_LABEL[s]] as [string, string]),
                  ]}
                />
                <Filter
                  label="Owner"
                  value={owner}
                  onChange={setOwner}
                  options={[
                    ["", "Anyone"],
                    ...owners.map((o) => [o.id, o.name] as [string, string]),
                  ]}
                />
                <Filter
                  label="Due"
                  value={due}
                  onChange={(v) => setDue(v as Due)}
                  options={[
                    ["any", "Any time"],
                    ["overdue", "Overdue"],
                    ["week", "Next 7 days"],
                    ["none", "No due date"],
                  ]}
                />
              </div>
              {commitments.error && (
                <p role="alert" className="mt-4 text-sm text-danger">
                  {commitments.error.message}
                </p>
              )}
              {commitments.isSuccess && rows.length === 0 && (
                <p className="mt-8 text-sm text-secondary">
                  No commitments match. Record or import a meeting to find some.
                </p>
              )}
              {rows.length > 0 && (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="text-xs text-tertiary">
                      <tr>
                        <th className="py-2 pr-3 font-medium">Commitment</th>
                        <th className="py-2 pr-3 font-medium">Owner</th>
                        <th className="py-2 pr-3 font-medium">Due</th>
                        <th className="py-2 pr-3 font-medium">Status</th>
                        <th className="py-2 font-medium">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((c) => (
                        <tr key={c.id} className="border-t border-border-base align-top">
                          <td className="py-3 pr-3">
                            <SafeText text={c.text} />
                            <div className="mt-1 text-xs text-secondary">
                              <DueDate c={c} />
                            </div>
                          </td>
                          <td className="py-3 pr-3">
                            <OwnerSelect c={c} owners={owners} />
                          </td>
                          <td className="py-3 pr-3">
                            <DeadlineInput c={c} />
                          </td>
                          <td className="py-3 pr-3">
                            <CommitmentStatusSelect c={c} />
                          </td>
                          <td className="py-3">
                            <SourceChip x={c} onOpen={setOpen} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : (
            <section aria-label="Decisions" className="mt-4">
              <label className="block max-w-sm text-sm">
                <span className="sr-only">Search decisions</span>
                <input
                  type="search"
                  value={q}
                  placeholder="Search decisions"
                  onChange={(e) => setQ(e.target.value)}
                  className="min-h-11 w-full rounded-md border border-border-strong bg-page px-3 text-sm"
                />
              </label>
              {decisions.error && (
                <p role="alert" className="mt-4 text-sm text-danger">
                  {decisions.error.message}
                </p>
              )}
              {decisions.isSuccess && decisions.data.decisions.length === 0 && (
                <p className="mt-8 text-sm text-secondary">No decisions found.</p>
              )}
              <ul className="mt-4 space-y-2">
                {decisions.data?.decisions.map((d) => (
                  <li
                    key={d.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg bg-raised px-4 py-3 shadow-raised-sm"
                  >
                    <span className="min-w-0 flex-1 text-sm">
                      <SafeText text={d.text} />
                    </span>
                    {d.decidedAt && (
                      <span className="text-xs text-secondary">
                        {new Date(d.decidedAt).toLocaleDateString()}
                      </span>
                    )}
                    <SourceChip x={d} onOpen={setOpen} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      {open && (
        <div className="fixed inset-0 z-30 lg:relative lg:z-20">
          <SourceViewer citation={open} onClose={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  const id = `filter-${label.toLowerCase()}`;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 rounded-md border border-border-strong bg-page px-2 text-sm"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

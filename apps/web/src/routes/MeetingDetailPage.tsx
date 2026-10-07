import type { Commitment, Decision } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, CircleAlert, Mic, RotateCcw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../api.ts";
import { AudioPlayer, clock, type PlayerHandle, TranscriptView } from "../components/capture.tsx";
import { MakeTasks } from "../components/MakeTasks.tsx";
import { SafeText } from "../components/SafeText.tsx";
import { Button, IconButton } from "../components/ui.tsx";
import { CommitmentStatusSelect, DueDate } from "./CommitmentsPage.tsx";
import { StatusBadge, useJobProgress } from "./MeetingsPage.tsx";

/** Evidence chip: the verbatim quote's timestamp; clicking seeks the audio there (acceptance #1). */
function EvidenceChip({
  item,
  onSeek,
}: {
  item: Commitment | Decision;
  onSeek: (ms: number) => void;
}) {
  if (item.anchor.kind !== "transcript") return null;
  const at = item.anchor.startMs;
  return (
    <button
      type="button"
      onClick={() => onSeek(at)}
      title={`“${item.evidenceQuote}”`}
      aria-label={`Play the evidence at ${clock(at)}: ${item.evidenceQuote}`}
      className="inline-flex h-7 items-center gap-1 rounded-full bg-layer-subtle px-2.5 text-xs font-medium text-secondary hover:bg-layer-strong"
    >
      <Mic size={12} aria-hidden /> {clock(at)}
    </button>
  );
}

/** DESIGN screen 5 (detail): summary, commitments and decisions left; transcript right; player docked. */
export function MeetingDetailPage() {
  const { id } = useParams({ from: "/meetings/$id" });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const player = useRef<PlayerHandle>(null);
  const [playhead, setPlayhead] = useState<number | undefined>(undefined);
  const [focusMs, setFocusMs] = useState<number | undefined>(undefined);
  const confirm = useRef<HTMLDialogElement>(null);

  const q = useQuery({
    queryKey: ["meeting", id],
    queryFn: () => api.meeting(id),
    refetchInterval: (query) => {
      const s = query.state.data?.meeting.status;
      return s && s !== "done" && s !== "failed" ? 5000 : false;
    },
  });
  const progress = useJobProgress(q.data?.meeting);
  const retry = useMutation({
    mutationFn: () => api.retryMeeting(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["meeting", id] }),
  });
  const del = useMutation({
    mutationFn: () => api.deleteMeeting(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["meetings"] });
      void navigate({ to: "/meetings" });
    },
  });

  const seek = (ms: number) => {
    setFocusMs(ms);
    player.current?.seek(ms);
  };

  if (q.isLoading) return <p className="p-16 text-sm text-secondary">Loading meeting…</p>;
  if (q.error || !q.data)
    return (
      <p role="alert" className="p-16 text-sm text-danger">
        {q.error?.message ?? "Meeting not found"}
      </p>
    );
  const { meeting: m, summary, commitments, decisions, segments } = q.data;

  return (
    <div className="flex h-full flex-col overflow-y-auto lg:overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-border-base px-4 pb-3 pt-14 sm:px-8">
        <Link
          to="/meetings"
          className="inline-flex size-11 items-center justify-center rounded-md text-primary hover:bg-layer-subtle"
          aria-label="Back to meetings"
        >
          <ArrowLeft size={20} aria-hidden />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-normal leading-7">{m.title}</h1>
          <p className="text-xs text-secondary">
            {m.startedAt ? new Date(m.startedAt).toLocaleString() : ""}
            {m.durationMs ? ` · ${clock(m.durationMs)}` : ""}
            {m.kind === "lecture" ? " · Lecture" : " · Meeting"}
          </p>
        </div>
        {progress?.progress != null && (
          <span className="tabular text-xs text-secondary">
            {progress.note} {Math.round(progress.progress * 100)}%
          </span>
        )}
        {m.status === "done" && <MakeTasks documentId={m.documentId} />}
        <StatusBadge status={m.status} />
        <IconButton label="Delete meeting" onClick={() => confirm.current?.showModal()}>
          <Trash2 size={18} aria-hidden />
        </IconButton>
      </header>

      {m.error && (
        <div
          role={m.status === "failed" ? "alert" : "status"}
          className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-md bg-accent-soft px-4 py-3 text-sm sm:mx-8"
        >
          <CircleAlert
            size={16}
            aria-hidden
            className={m.status === "failed" ? "text-danger" : "text-warning"}
          />
          <span className="min-w-0 flex-1 break-words">
            {m.error} <span className="font-mono text-xs text-tertiary">(meeting {m.id})</span>
          </span>
          {m.status === "failed" && (
            <Button variant="secondary" disabled={retry.isPending} onClick={() => retry.mutate()}>
              <RotateCcw size={14} aria-hidden /> Retry
            </Button>
          )}
          {retry.error && <span className="w-full text-danger">{retry.error.message}</span>}
        </div>
      )}

      <div className="grid flex-1 gap-0 lg:min-h-0 lg:grid-cols-2">
        <section
          aria-label="Summary and extracted items"
          className="min-w-0 space-y-8 px-4 py-6 sm:px-8 lg:min-h-0 lg:overflow-auto"
        >
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-tertiary">Summary</h2>
            {summary ? (
              <div className="mt-2 space-y-3">
                <p className="font-answer text-base leading-[26px]">
                  <SafeText text={summary.summary} />
                </p>
                {summary.topics.length > 0 && (
                  <p className="text-sm text-secondary">Topics: {summary.topics.join(" · ")}</p>
                )}
                {summary.openQuestions.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium">Open questions</h3>
                    <ul className="mt-1 list-disc pl-5 text-sm text-secondary">
                      {summary.openQuestions.map((oq) => (
                        <li key={oq}>
                          <SafeText text={oq} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {summary.path && (
                  <p className="break-words font-mono text-xs text-tertiary">
                    {summary.path.local ? "Local" : "API"} · {summary.path.model}
                    {summary.path.fallbackReason &&
                      ` (fallback: ${summary.path.fallbackReason.replace(/_/g, " ")})`}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-2 text-sm text-secondary">
                {m.status === "done"
                  ? "No summary."
                  : "The summary appears after transcription and extraction."}
              </p>
            )}
          </div>

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-tertiary">
              Commitments ({commitments.length})
            </h2>
            {commitments.length === 0 && <p className="mt-2 text-sm text-secondary">None found.</p>}
            <ul className="mt-2 space-y-3">
              {commitments.map((c) => (
                <li key={c.id} className="rounded-lg bg-raised p-3 shadow-raised-sm">
                  <p className="text-sm text-primary">
                    <SafeText text={c.text} />
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-secondary">
                    <span>{c.ownerName ?? "Owner unknown"}</span>
                    <DueDate c={c} />
                    <EvidenceChip item={c} onSeek={seek} />
                    <span className="ml-auto">
                      <CommitmentStatusSelect c={c} />
                    </span>
                  </div>
                  <blockquote className="mt-2 border-l-2 border-accent-strong pl-2 text-xs text-tertiary">
                    “{c.evidenceQuote}”
                  </blockquote>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-tertiary">
              Decisions ({decisions.length})
            </h2>
            {decisions.length === 0 && <p className="mt-2 text-sm text-secondary">None found.</p>}
            <ul className="mt-2 space-y-2">
              {decisions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <SafeText text={d.text} />
                  </span>
                  <EvidenceChip item={d} onSeek={seek} />
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          aria-label="Transcript"
          className="flex min-w-0 flex-col border-t border-border-base lg:min-h-0 lg:border-l lg:border-t-0"
        >
          <div className="flex-1 px-4 py-6 sm:px-6 lg:min-h-0 lg:overflow-auto">
            <TranscriptView
              segments={segments}
              currentMs={playhead}
              focusMs={focusMs}
              onSeek={m.audioUrl ? seek : undefined}
            />
          </div>
          {m.audioUrl && (
            <div className="sticky bottom-0">
              <AudioPlayer ref={player} src={m.audioUrl} onTime={setPlayhead} />
            </div>
          )}
        </section>
      </div>

      <dialog
        ref={confirm}
        aria-labelledby="delete-meeting-title"
        className="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl bg-overlay p-6 text-primary shadow-raised-lg backdrop:bg-scrim"
      >
        <h2 id="delete-meeting-title" className="text-lg font-semibold">
          Delete this meeting?
        </h2>
        <p className="mt-2 text-sm text-secondary">
          This permanently removes the audio, the transcript, its search index, and the{" "}
          {commitments.length} commitment(s) and {decisions.length} decision(s) extracted from it.
        </p>
        {del.error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {del.error.message}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => confirm.current?.close()}>
            Cancel
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>
            Delete meeting
          </Button>
        </div>
      </dialog>
    </div>
  );
}

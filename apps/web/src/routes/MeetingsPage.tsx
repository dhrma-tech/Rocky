import type { JobEvent, Meeting, MeetingKind, TranscriptionStatus } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, FileAudio, Loader, Mic, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, uploadMedia, watchJob } from "../api.ts";
import { useRecorder } from "../audio/recorder.ts";
import { ConsentDialog, clock } from "../components/capture.tsx";
import { Badge, Button } from "../components/ui.tsx";

export const STATUS: Record<
  TranscriptionStatus,
  { label: string; tone: "neutral" | "info" | "success" | "danger" }
> = {
  recording: { label: "Recording", tone: "danger" },
  queued: { label: "Queued", tone: "neutral" },
  transcribing: { label: "Transcribing", tone: "info" },
  understanding: { label: "Extracting", tone: "info" },
  done: { label: "Ready", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

export function StatusBadge({ status }: { status: TranscriptionStatus }) {
  const s = STATUS[status];
  const Icon = status === "done" ? CircleCheck : status === "failed" ? CircleAlert : Loader;
  return (
    <Badge tone={s.tone}>
      <Icon size={14} aria-hidden />
      {s.label}
    </Badge>
  );
}

const busy = (s: TranscriptionStatus) =>
  s === "queued" || s === "transcribing" || s === "understanding";

/** Live progress of a meeting's current job (GET /jobs/:id/events); refreshes the meeting when it ends. */
export function useJobProgress(m: Pick<Meeting, "id" | "jobId" | "status"> | undefined) {
  const qc = useQueryClient();
  const [ev, setEv] = useState<JobEvent | null>(null);
  const jobId = m && busy(m.status) ? m.jobId : null;
  useEffect(() => {
    if (!jobId) return;
    setEv(null);
    return watchJob(jobId, (e) => {
      setEv(e);
      if (e.status === "done" || e.status === "failed") {
        void qc.invalidateQueries({ queryKey: ["meetings"] });
        void qc.invalidateQueries({ queryKey: ["meeting"] });
        void qc.invalidateQueries({ queryKey: ["commitments"] });
      }
    });
  }, [jobId, qc]);
  return jobId ? ev : null;
}

function Progress({ meeting }: { meeting: Meeting }) {
  const ev = useJobProgress(meeting);
  if (!ev || ev.progress === null) return null;
  return (
    <span className="tabular text-xs text-secondary">
      {ev.note ?? ""} {Math.round(ev.progress * 100)}%
    </span>
  );
}

const date = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

/** DESIGN screen 5 (list): title, date, duration, source, commitments count; Record and Import. */
export function MeetingsPage() {
  const [consent, setConsent] = useState(false);
  const rec = useRecorder();
  const list = useQuery({
    queryKey: ["meetings"],
    queryFn: api.meetings,
    refetchInterval: (q) =>
      q.state.data?.meetings.some((m) => busy(m.status) || m.status === "recording") ? 5000 : false,
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-normal leading-8">Meetings</h1>
        <ImportButton />
        <Button variant="primary" disabled={rec.phase !== "idle"} onClick={() => setConsent(true)}>
          <Mic size={16} aria-hidden /> Record
        </Button>
      </header>
      <p className="mt-2 text-sm text-secondary">
        Record a call or lecture from this browser, or import a recording. Transcription runs on
        this computer.
      </p>
      <ConsentDialog open={consent} onClose={() => setConsent(false)} />

      <section aria-label="Meetings" className="mt-8">
        {list.isLoading && (
          <ul aria-hidden className="space-y-2">
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className="h-16 animate-pulse rounded-lg bg-layer-subtle motion-reduce:animate-none"
              />
            ))}
          </ul>
        )}
        {list.error && (
          <p role="alert" className="text-sm text-danger">
            {list.error.message}
          </p>
        )}
        {list.data?.meetings.length === 0 && (
          <div className="rounded-lg bg-raised p-8 text-center shadow-raised-sm">
            <FileAudio size={24} aria-hidden className="mx-auto text-accent-strong" />
            <p className="mt-2 text-sm text-secondary">
              No meetings yet. Record one or import a file.
            </p>
          </div>
        )}
        <ul className="space-y-2">
          {list.data?.meetings.map((m) => (
            <li key={m.id}>
              <Link
                to="/meetings/$id"
                params={{ id: m.id }}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-raised px-4 py-3 text-primary no-underline shadow-raised-sm transition-colors duration-[180ms] ease-ui hover:bg-accent-soft-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.title}</span>
                  <span className="block text-xs text-secondary">
                    {date(m.startedAt)}
                    {m.durationMs ? ` · ${clock(m.durationMs)}` : ""} ·{" "}
                    {m.source === "import" ? "Imported" : "Recorded"} ·{" "}
                    {m.kind === "lecture" ? "Lecture" : "Meeting"}
                  </span>
                </span>
                <Progress meeting={m} />
                {m.commitmentCount > 0 && (
                  <span className="text-xs text-secondary">
                    {m.commitmentCount} commitment{m.commitmentCount === 1 ? "" : "s"}
                  </span>
                )}
                <StatusBadge status={m.status} />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ImportButton() {
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const [progress, setProgress] = useState<number | null>(null);
  const [kind, setKind] = useState<MeetingKind>("lecture");
  const upload = useMutation({
    mutationFn: (file: File) => uploadMedia(file, { kind, onProgress: setProgress }),
    onSettled: () => {
      setProgress(null);
      void qc.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="import-kind">
        Import as
      </label>
      <select
        id="import-kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as MeetingKind)}
        className="min-h-11 rounded-md border border-border-strong bg-page px-2 text-sm"
      >
        <option value="lecture">Lecture</option>
        <option value="meeting">Meeting</option>
      </select>
      <input
        ref={input}
        type="file"
        accept="audio/*,video/*,.mkv,.m4a"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = "";
        }}
      />
      <Button disabled={upload.isPending} onClick={() => input.current?.click()}>
        <Upload size={16} aria-hidden />
        {upload.isPending ? `Uploading ${Math.round((progress ?? 0) * 100)}%` : "Import recording"}
      </Button>
      {upload.error && (
        <p role="alert" className="w-full text-sm text-danger">
          {upload.error.message}
        </p>
      )}
    </div>
  );
}

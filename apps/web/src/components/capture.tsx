import type { MeetingKind, TranscriptSegment } from "@rocky/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Mic, Pause, Play, Square } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "../api.ts";
import {
  clearRecorderError,
  elapsedMs,
  setPaused,
  startRecording,
  stopRecording,
  useRecorder,
} from "../audio/recorder.ts";
import { Button, cls, IconButton } from "./ui.tsx";

/** 754000 → "12:34", 3_754_000 → "1:02:34". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/**
 * "Before you record" (DESIGN §5.7, capture.md step 1): both boxes must be ticked; the consent is
 * written to the audit log when the recording starts.
 */
export function ConsentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [informed, setInformed] = useState(false);
  const [laws, setLaws] = useState(false);
  const [kind, setKind] = useState<MeetingKind>("meeting");
  const [title, setTitle] = useState("");

  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal();
    if (!open && d?.open) d.close();
  }, [open]);

  const start = () => {
    onClose();
    void startRecording({ kind, ...(title.trim() ? { title: title.trim() } : {}) });
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="consent-title"
      onClose={() => {
        setInformed(false);
        setLaws(false);
        onClose();
      }}
      className="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl bg-overlay p-6 text-primary shadow-raised-lg backdrop:bg-scrim"
    >
      <h2 id="consent-title" className="text-lg font-semibold">
        Before you record
      </h2>
      <p className="mt-2 text-sm text-secondary">
        The audio stays on this computer. Rocky transcribes it locally with whisper; only the text
        may go to an API model for extraction, unless local-only mode is on.
      </p>
      <p className="mt-2 text-sm text-secondary">
        Next, your browser asks which tab or screen to share. Pick the meeting tab with{" "}
        <strong className="font-medium text-primary">Share tab audio</strong>, or the entire screen
        with <strong className="font-medium text-primary">Share system audio</strong> for the Zoom
        or Teams app. Use headphones so the other side isn't recorded twice.
      </p>
      <fieldset className="mt-4 space-y-3">
        <legend className="sr-only">Consent</legend>
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={informed}
            onChange={(e) => setInformed(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-[var(--accent-strong)]"
          />
          <span>I have permission from everyone on this call to record it.</span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={laws}
            onChange={(e) => setLaws(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-[var(--accent-strong)]"
          />
          <span>
            I understand that recording laws vary by place, and following them is my responsibility.
          </span>
        </label>
      </fieldset>
      <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr]">
        <label className="text-sm font-medium" htmlFor="rec-kind">
          Type
        </label>
        <select
          id="rec-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as MeetingKind)}
          className="min-h-11 rounded-md border border-border-strong bg-page px-3 text-sm"
        >
          <option value="meeting">Meeting</option>
          <option value="lecture">Lecture</option>
        </select>
        <label className="text-sm font-medium" htmlFor="rec-title">
          Title
        </label>
        <input
          id="rec-title"
          value={title}
          placeholder="Optional; Rocky suggests one"
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          className="min-h-11 rounded-md border border-border-strong bg-page px-3 text-sm"
        />
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => dialog.current?.close()}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!informed || !laws} onClick={start}>
          <Mic size={16} aria-hidden /> Start recording
        </Button>
      </div>
    </dialog>
  );
}

/**
 * Recording pill (DESIGN §5.7): top-center, always visible while recording, z-80. Also offers to
 * finish a recording left open by a closed or reloaded tab (capture.md step 5).
 */
export function RecordingPill() {
  const rec = useRecorder();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());
  const active = useQuery({
    queryKey: ["recordings", "active"],
    queryFn: api.activeRecordings,
    refetchInterval: 5000,
  });
  const live = rec.phase === "recording" || rec.phase === "stopping";
  const orphan = !live && rec.phase !== "starting" ? active.data?.recordings[0] : undefined;

  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [live]);

  // "● REC" in the tab title while recording (capture.md step 6).
  useEffect(() => {
    if (!live) return;
    const base = document.title.replace(/^● REC · /, "");
    document.title = `● REC · ${base}`;
    return () => {
      document.title = base;
    };
  }, [live]);

  const stop = async () => {
    const id = await stopRecording();
    await qc.invalidateQueries({ queryKey: ["meetings"] });
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    if (id) void navigate({ to: "/meetings/$id", params: { id } });
  };
  const finishOrphan = async (id: string) => {
    await api.stopRecording(id).catch(() => {});
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    await qc.invalidateQueries({ queryKey: ["meetings"] });
    void navigate({ to: "/meetings/$id", params: { id } });
  };

  if (rec.error)
    return (
      <Pill>
        <p role="alert" className="max-w-[60ch] text-sm text-danger">
          {rec.error}
        </p>
        <Button variant="ghost" className="min-h-9" onClick={clearRecorderError}>
          Dismiss
        </Button>
      </Pill>
    );
  if (orphan)
    return (
      <Pill>
        <span className="text-sm">An unfinished recording was found.</span>
        <Button
          variant="secondary"
          className="min-h-9"
          onClick={() => void finishOrphan(orphan.id)}
        >
          Finish recording
        </Button>
      </Pill>
    );
  if (!live && rec.phase !== "starting") return null;

  const paused = rec.pausedAt !== null;
  return (
    <Pill>
      <span
        aria-hidden
        className={cls(
          "size-2 rounded-full bg-danger",
          !paused && rec.phase === "recording" && "pulse-dot",
        )}
      />
      <span className="text-sm font-medium" role="status">
        {rec.phase === "starting"
          ? "Starting…"
          : rec.phase === "stopping"
            ? "Saving…"
            : paused
              ? "Paused"
              : "Recording"}
      </span>
      {live && (
        <span className="tabular font-mono text-sm text-secondary">
          {clock(elapsedMs(rec, now))}
        </span>
      )}
      {rec.micOnly && live && (
        <span className="text-xs text-warning" title="The screen share had no audio track.">
          System audio not shared: mic only
        </span>
      )}
      {rec.lostChunks > 0 && (
        <span className="text-xs text-danger">{rec.lostChunks} chunk(s) failed to save</span>
      )}
      {rec.phase === "recording" && (
        <>
          <IconButton
            label={paused ? "Resume recording" : "Pause recording"}
            onClick={() => setPaused(!paused)}
          >
            {paused ? <Play size={18} aria-hidden /> : <Pause size={18} aria-hidden />}
          </IconButton>
          <Button variant="secondary" className="min-h-9" onClick={() => void stop()}>
            <Square size={14} aria-hidden /> Stop
          </Button>
        </>
      )}
    </Pill>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-[80] flex justify-center px-4">
      <div className="pointer-events-auto flex min-h-10 flex-wrap items-center gap-3 rounded-full bg-raised py-1 pl-4 pr-1 shadow-float">
        {children}
      </div>
    </div>
  );
}

export interface PlayerHandle {
  seek(ms: number): void;
}

const SPEEDS = [1, 1.25, 1.5, 2];

/** Docked audio player (DESIGN screen 5): play, scrub, speed. Reports the playhead in ms. */
export const AudioPlayer = forwardRef<PlayerHandle, { src: string; onTime?: (ms: number) => void }>(
  function AudioPlayer({ src, onTime }, ref) {
    const audio = useRef<HTMLAudioElement>(null);
    const [playing, setPlaying] = useState(false);
    const [t, setT] = useState(0);
    const [dur, setDur] = useState(0);
    const [speed, setSpeed] = useState(1);

    useImperativeHandle(ref, () => ({
      seek(ms: number) {
        const a = audio.current;
        if (!a) return;
        a.currentTime = ms / 1000;
        void a.play();
      },
    }));

    return (
      <div className="flex items-center gap-3 border-t border-border-base bg-raised px-4 py-2">
        {/* biome-ignore lint/a11y/useMediaCaption: the transcript beside the player is the caption. */}
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration * 1000)}
          onTimeUpdate={(e) => {
            const ms = e.currentTarget.currentTime * 1000;
            setT(ms);
            onTime?.(ms);
          }}
        />
        <IconButton
          label={playing ? "Pause" : "Play"}
          onClick={() => (playing ? audio.current?.pause() : void audio.current?.play())}
        >
          {playing ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}
        </IconButton>
        <span className="tabular w-14 font-mono text-xs text-secondary">{clock(t)}</span>
        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={Math.max(1, Math.floor(dur))}
          value={Math.floor(t)}
          onChange={(e) => {
            if (audio.current) audio.current.currentTime = Number(e.target.value) / 1000;
          }}
          className="h-11 min-w-0 flex-1 accent-[var(--accent-strong)]"
        />
        <span className="tabular w-14 font-mono text-xs text-secondary">{clock(dur)}</span>
        <button
          type="button"
          aria-label={`Playback speed ${speed}x`}
          onClick={() => {
            const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;
            setSpeed(next);
            if (audio.current) audio.current.playbackRate = next;
          }}
          className="min-h-11 min-w-11 rounded-md font-mono text-xs text-primary hover:bg-layer-subtle"
        >
          {speed}x
        </button>
      </div>
    );
  },
);

/**
 * Transcript view (DESIGN §5.7): speaker label, clickable timestamp chip, text; the row under the
 * playhead is highlighted and kept in view.
 */
export function TranscriptView({
  segments,
  currentMs,
  focusMs,
  onSeek,
}: {
  segments: TranscriptSegment[];
  currentMs?: number | undefined;
  /** Scrolls this time into view once (e.g. the cited window). */
  focusMs?: number | undefined;
  onSeek?: ((ms: number) => void) | undefined;
}) {
  const rows = useRef<Map<string, HTMLLIElement>>(new Map());
  const activeId =
    currentMs === undefined
      ? undefined
      : segments.findLast((s) => s.startMs <= currentMs && currentMs < s.endMs + 1000)?.id;
  // Channels overlap in time, so prefer the segment that starts exactly at the cited moment.
  const focusId =
    focusMs === undefined
      ? undefined
      : (
          segments.find((s) => s.startMs === focusMs) ??
          segments.find((s) => s.startMs <= focusMs && focusMs < s.endMs) ??
          segments.find((s) => s.endMs >= focusMs)
        )?.id;

  useEffect(() => {
    if (focusId) rows.current.get(focusId)?.scrollIntoView({ block: "center" });
  }, [focusId]);
  useEffect(() => {
    if (activeId) rows.current.get(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  if (!segments.length) return <p className="text-sm text-secondary">No transcript yet.</p>;
  return (
    <ol className="space-y-1">
      {segments.map((s) => (
        <li
          key={s.id}
          ref={(el) => {
            if (el) rows.current.set(s.id, el);
            else rows.current.delete(s.id);
          }}
          className={cls(
            "grid grid-cols-[auto_1fr] gap-x-3 rounded-md px-2 py-1.5",
            (s.id === activeId || (activeId === undefined && s.id === focusId)) && "bg-accent-soft",
          )}
        >
          <div className="flex flex-col items-start gap-1 pt-0.5">
            <span className="font-mono text-xs text-secondary">{s.speakerLabel}</span>
            <button
              type="button"
              onClick={() => onSeek?.(s.startMs)}
              disabled={!onSeek}
              aria-label={`Play from ${clock(s.startMs)}`}
              className="tabular rounded-full bg-layer-subtle px-2 font-mono text-xs leading-5 text-primary hover:bg-layer-strong disabled:cursor-default"
            >
              {clock(s.startMs)}
            </button>
          </div>
          <p className="text-base leading-[26px] text-primary">{s.text}</p>
        </li>
      ))}
    </ol>
  );
}

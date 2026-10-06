import type { MeetingKind } from "@rocky/contracts";
import { useSyncExternalStore } from "react";
import { api } from "../api.ts";
import { ChannelBuffer } from "./pcm.ts";

/**
 * Browser recorder (capture.md): mic and system/tab audio as two separate channels, resampled to
 * 16 kHz Int16 and PUT to the daemon every 5 s, so a crashed tab loses at most 5 s.
 * One recording at a time; state lives at module level so it survives route changes.
 */

const CHUNK_MS = 5000;
const MAX_TRIES = 3;

export type RecorderPhase = "idle" | "starting" | "recording" | "stopping";

export interface RecorderState {
  phase: RecorderPhase;
  meetingId: string | null;
  startedAt: number | null;
  /** Milliseconds of paused time, excluded from the timer. */
  pausedMs: number;
  pausedAt: number | null;
  /** True when the screen/tab share returned no audio track: mic only. */
  micOnly: boolean;
  /** Chunks that failed to upload after retries (data loss the user should know about). */
  lostChunks: number;
  error: string | null;
}

const initial: RecorderState = {
  phase: "idle",
  meetingId: null,
  startedAt: null,
  pausedMs: 0,
  pausedAt: null,
  micOnly: false,
  lostChunks: 0,
  error: null,
};

let state = initial;
const listeners = new Set<() => void>();
const set = (patch: Partial<RecorderState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

export function useRecorder(): RecorderState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

interface Session {
  ctx: AudioContext;
  streams: MediaStream[];
  nodes: AudioWorkletNode[];
  buffers: Partial<Record<"mic" | "system", ChannelBuffer>>;
  timer: number;
  n: number;
  uploads: Promise<void>;
}
let session: Session | null = null;

/** Human-readable reason for a getUserMedia/getDisplayMedia failure (DESIGN §5.9). */
export function permissionMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError")
    return "Microphone access was blocked. Click the lock icon in the address bar, allow the microphone for this site, then try again.";
  if (name === "NotFoundError") return "No microphone was found. Connect one and try again.";
  if (name === "NotReadableError")
    return "The microphone is in use by another app or blocked by Windows privacy settings (Settings → Privacy → Microphone).";
  return err instanceof Error ? err.message : String(err);
}

async function putWithRetry(id: string, channel: "mic" | "system", n: number, bytes: Uint8Array) {
  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      await api.putChunk(id, channel, n, bytes);
      return;
    } catch {
      if (i < MAX_TRIES) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  set({ lostChunks: state.lostChunks + 1 });
}

/** Sends whatever is buffered as chunk n on both channels (same n keeps them aligned). */
function flush(s: Session, id: string) {
  const n = s.n++;
  const parts = (["mic", "system"] as const).flatMap((c) => {
    const buf = s.buffers[c];
    return buf ? [[c, buf.take()] as const] : [];
  });
  s.uploads = s.uploads.then(() =>
    Promise.all(parts.map(([c, bytes]) => putWithRetry(id, c, n, bytes))).then(() => {}),
  );
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
}

export async function startRecording(opts: { kind: MeetingKind; title?: string }): Promise<void> {
  if (state.phase !== "idle") return;
  set({ ...initial, phase: "starting" });
  const streams: MediaStream[] = [];
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    streams.push(mic);
    // Chrome needs video in the request; the track is stopped at once. The user picks a tab
    // ("Share tab audio") or the entire screen ("Share system audio").
    let display: MediaStream | null = null;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        systemAudio: "include",
      } as DisplayMediaStreamOptions);
      for (const t of display.getVideoTracks()) t.stop();
      if (display.getAudioTracks().length) streams.push(display);
    } catch {
      // Cancelled the share dialog: record the mic only.
    }
    const micOnly = !display || display.getAudioTracks().length === 0;

    const { id } = await api.startRecording({
      kind: opts.kind,
      ...(opts.title ? { title: opts.title } : {}),
      consent: { participantsInformed: true, lawsAck: true },
    });

    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule("/pcm-worklet.js");
    const sink = ctx.createGain();
    sink.gain.value = 0; // Worklets only run when connected to the graph; nothing is played back.
    sink.connect(ctx.destination);
    const buffers: Session["buffers"] = {};
    const nodes: AudioWorkletNode[] = [];
    const attach = (channel: "mic" | "system", stream: MediaStream) => {
      const buf = new ChannelBuffer(ctx.sampleRate);
      buffers[channel] = buf;
      const node = new AudioWorkletNode(ctx, "pcm-capture");
      node.port.onmessage = (e: MessageEvent<Float32Array>) => buf.push(e.data);
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(sink);
      nodes.push(node);
    };
    attach("mic", mic);
    if (!micOnly && display) attach("system", display);
    // The browser's own "Stop sharing" button ends the system track; keep recording the mic.
    display?.getAudioTracks()[0]?.addEventListener("ended", () => set({ micOnly: true }));

    const s: Session = { ctx, streams, nodes, buffers, timer: 0, n: 0, uploads: Promise.resolve() };
    s.timer = window.setInterval(() => flush(s, id), CHUNK_MS);
    session = s;
    window.addEventListener("beforeunload", onBeforeUnload);
    set({ phase: "recording", meetingId: id, startedAt: Date.now(), micOnly });
  } catch (err) {
    for (const st of streams) for (const t of st.getTracks()) t.stop();
    set({ ...initial, error: permissionMessage(err) });
  }
}

export function setPaused(paused: boolean) {
  if (!session || state.phase !== "recording") return;
  for (const node of session.nodes) node.port.postMessage({ paused });
  if (paused) set({ pausedAt: Date.now() });
  else if (state.pausedAt)
    set({ pausedMs: state.pausedMs + Date.now() - state.pausedAt, pausedAt: null });
}

/** Stops capture, uploads the last chunk, and asks the daemon to transcribe. */
export async function stopRecording(): Promise<string | null> {
  const s = session;
  const id = state.meetingId;
  if (!s || !id || state.phase !== "recording") return null;
  set({ phase: "stopping" });
  window.clearInterval(s.timer);
  flush(s, id);
  for (const st of s.streams) for (const t of st.getTracks()) t.stop();
  await s.ctx.close();
  await s.uploads;
  session = null;
  window.removeEventListener("beforeunload", onBeforeUnload);
  try {
    await api.stopRecording(id);
    set({ ...initial });
    return id;
  } catch (err) {
    set({ ...initial, error: err instanceof Error ? err.message : String(err) });
    return id;
  }
}

export function clearRecorderError() {
  set({ error: null });
}

export const elapsedMs = (s: RecorderState, now: number) =>
  s.startedAt ? now - s.startedAt - s.pausedMs - (s.pausedAt ? now - s.pausedAt : 0) : 0;

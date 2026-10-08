import type { AgentState, RockyEvent } from "@rocky/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { api, type StreamState, subscribeEvents } from "../api.ts";
import { foldRuns, type RunView } from "./runs.ts";
import { overallState } from "./status.ts";

/**
 * One live connection for the whole app (UI spec "Live updates"): the newest events, then the SSE
 * stream, which replays anything missed after a reconnect. Every screen reads runs from here, so
 * the sidebar pebble, Today, the run page and the ledger always agree.
 */

const KEEP = 2000;

export interface Live {
  events: RockyEvent[];
  runs: Map<string, RunView>;
  stream: StreamState | "connecting" | "off";
  loading: boolean;
  error: Error | null;
}

const LiveCtx = createContext<Live>({
  events: [],
  runs: new Map(),
  stream: "off",
  loading: false,
  error: null,
});

export function LiveProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const qc = useQueryClient();
  const [events, setEvents] = useState<RockyEvent[]>([]);
  const [stream, setStream] = useState<Live["stream"]>("off");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let stop = () => {};
    let cancelled = false;
    setStream("connecting");
    api
      .recentEvents(500)
      .then((page) => {
        if (cancelled) return;
        setEvents(page.events);
        setLoading(false);
        stop = subscribeEvents(
          page.last,
          (e) => {
            setEvents((xs) => [...xs, e].slice(-KEEP));
            // The queue and its badge follow approval events without polling.
            if (e.kind === "approval") void qc.invalidateQueries({ queryKey: ["actions"] });
          },
          setStream,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, qc]);

  const runs = useMemo(() => foldRuns(events), [events]);
  const value = useMemo(
    () => ({ events, runs, stream, loading, error }),
    [events, runs, stream, loading, error],
  );
  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>;
}

export const useLive = () => useContext(LiveCtx);

/** The sidebar pebble's state: anything waiting on the user first. */
export function useOverallState(pendingApprovals: number): AgentState | null {
  const { runs } = useLive();
  const recent = Date.now() - 15 * 60_000;
  // An old failure stays in the ledger; the pebble only shows one from the last 15 minutes.
  const states = [...runs.values()]
    .filter((r) => r.state !== "failed" || r.updatedAt >= recent)
    .map((r) => r.state);
  if (pendingApprovals > 0) states.push("needs_approval");
  return overallState(states);
}

/** A clock that ticks every second, for elapsed times and Undo countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

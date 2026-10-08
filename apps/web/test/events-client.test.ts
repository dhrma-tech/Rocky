// subscribeEvents: the browser's own data-less "error" event (a dropped connection) must not be
// mistaken for an "error" kind event, and replayed events are dropped.
import { afterEach, describe, expect, it } from "vitest";
import { subscribeEvents } from "../src/api.ts";

type Listener = (m: { data?: string }) => void;
class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Map<string, Listener[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, l: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  emit(type: string, data?: unknown) {
    for (const l of this.listeners.get(type) ?? [])
      l(data === undefined ? {} : { data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

const original = globalThis.EventSource;
afterEach(() => {
  globalThis.EventSource = original;
});

describe("subscribeEvents", () => {
  it("ignores the browser's error event, reports state, and drops replays", () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const got: number[] = [];
    const states: string[] = [];
    const stop = subscribeEvents(
      5,
      (e) => got.push(e.seq),
      (s) => states.push(s),
    );
    const es = FakeEventSource.last as FakeEventSource;
    expect(es.url).toBe("/api/v1/events?after=5");
    es.onopen?.();
    expect(() => es.emit("error")).not.toThrow();
    es.onerror?.();
    const base = { at: 1, runId: null, code: "X", message: "m" };
    es.emit("error", { ...base, seq: 6, kind: "error" });
    es.emit("error", { ...base, seq: 6, kind: "error" });
    es.emit("error", { ...base, seq: 4, kind: "error" });
    expect(got).toEqual([6]);
    expect(states).toEqual(["live", "reconnecting"]);
    stop();
    expect(es.closed).toBe(true);
  });
});

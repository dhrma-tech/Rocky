import type { AgentState } from "@rocky/contracts";
import {
  Bookmark,
  BookOpen,
  CircleCheck,
  Clock,
  Globe,
  Hand,
  Info,
  type LucideIcon,
  Moon,
  OctagonX,
  Wrench,
} from "lucide-react";

/**
 * One status value, four places (UI spec "Where state shows"): the pebble, the status chip, the
 * timeline node and the notification all render from `STATUS[state]`, so they always agree.
 * Colour decorates; the icon and the word carry the meaning.
 */

export type Tone = "info" | "warning" | "success" | "error" | "neutral";

/** How the pebble looks in this state (UI spec "The eleven states", Pebble column). */
export type PebbleMode =
  | "breathing"
  | "breathing-tool"
  | "breathing-globe"
  | "needs-you"
  | "done"
  | "failed"
  | "dimmed"
  | "quiet"
  | "learned"
  | "rest";

export interface StatusView {
  tone: Tone;
  icon: LucideIcon;
  /** The chip's word. Details ("step 3 of 7", "example.com") are appended by the caller. */
  word: string;
  pebble: PebbleMode;
  /** True when the user is the one being waited on (blush, "Needs you"). */
  needsUser: boolean;
}

export const STATUS: Record<AgentState, StatusView> = {
  thinking: { tone: "info", icon: Info, word: "Thinking", pebble: "breathing", needsUser: false },
  working: { tone: "info", icon: Info, word: "Working", pebble: "breathing", needsUser: false },
  browsing: {
    tone: "info",
    icon: Globe,
    word: "Browsing",
    pebble: "breathing-globe",
    needsUser: false,
  },
  using_tool: {
    tone: "info",
    icon: Wrench,
    word: "Working",
    pebble: "breathing-tool",
    needsUser: false,
  },
  needs_approval: {
    tone: "warning",
    icon: Hand,
    word: "Needs you",
    pebble: "needs-you",
    needsUser: true,
  },
  completed: { tone: "success", icon: CircleCheck, word: "Done", pebble: "done", needsUser: false },
  failed: { tone: "error", icon: OctagonX, word: "Failed", pebble: "failed", needsUser: false },
  waiting: { tone: "neutral", icon: Clock, word: "Waiting", pebble: "dimmed", needsUser: false },
  background: {
    tone: "neutral",
    icon: Moon,
    word: "Background",
    pebble: "quiet",
    needsUser: false,
  },
  learned: { tone: "info", icon: Bookmark, word: "Learned", pebble: "learned", needsUser: false },
  remembers: {
    tone: "neutral",
    icon: BookOpen,
    word: "Used memory",
    pebble: "rest",
    needsUser: false,
  },
};

export const AGENT_STATES = Object.keys(STATUS) as AgentState[];

/** The chip text for a state plus its detail: "Working · step 3 of 7", "Browsing example.com". */
export function statusLabel(
  state: AgentState,
  detail?: { step?: { n: number; of?: number }; host?: string; memory?: string },
): string {
  const v = STATUS[state];
  if (state === "working" && detail?.step)
    return `${v.word} · step ${detail.step.n}${detail.step.of ? ` of ${detail.step.of}` : ""}`;
  if (state === "browsing" && detail?.host) return `${v.word} ${detail.host}`;
  if (state === "remembers" && detail?.memory) return `${v.word}: ${detail.memory}`;
  return v.word;
}

/**
 * The overall state shown on the sidebar pebble: anything waiting on the user wins, then failure,
 * then work in flight, then background work, then rest (spec: "Needs you" always comes first).
 */
export function overallState(states: AgentState[]): AgentState | null {
  const order: AgentState[] = [
    "needs_approval",
    "failed",
    "working",
    "using_tool",
    "browsing",
    "thinking",
    "background",
    "waiting",
  ];
  return order.find((s) => states.includes(s)) ?? null;
}

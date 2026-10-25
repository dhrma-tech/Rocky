import type { Citation } from "@rocky/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, FileText, Mail, Mic, ShieldCheck } from "lucide-react";
import { cls } from "./ui.tsx";

/** Where model calls may go: local-only mode, the routing mode (roadmap M4, D-068). */
export type Boundary = "local_only" | "local_first" | "cloud_first";

const BOUNDARY: Record<Boundary, { word: string; tone: "success" | "warning"; title: string }> = {
  local_only: {
    word: "Local only",
    tone: "success",
    title: "Every model call stays on this machine.",
  },
  local_first: {
    word: "Local first",
    tone: "success",
    title:
      "Everything runs on this machine. A question goes to a cloud model only when you send it, after seeing what it would get.",
  },
  cloud_first: {
    word: "Can use cloud",
    tone: "warning",
    title:
      "Background tasks may call a cloud model. Switch to local first in Settings to keep them on this machine.",
  },
};

/** The trust boundary chip (§5.7). Clicking opens Privacy settings. */
export function LocalBadge({ boundary }: { boundary: Boundary | undefined }) {
  if (boundary === undefined) return null;
  const b = BOUNDARY[boundary];
  return (
    <Link to="/settings" search={{ section: "privacy" }} className="rk-boundary" title={b.title}>
      {/* The boundary is a chip (icon, word, tint); the link around it is the 44px target. */}
      <span className={`rk-chip rk-chip--${b.tone}`}>
        {b.tone === "success" ? (
          <ShieldCheck size={14} aria-hidden />
        ) : (
          <ArrowUpRight size={14} aria-hidden />
        )}
        {b.word}
      </span>
    </Link>
  );
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** 4 px bar; warning at 80 %, danger at 100 % (§5.7). */
export function BudgetMeter({ spent, cap }: { spent: number; cap: number }) {
  const ratio = cap > 0 ? Math.min(spent / cap, 1) : 0;
  const tone = ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "bg-accent-2";
  return (
    <div className="flex flex-col gap-1.5">
      {/* Native meter for assistive tech; the styled bar is decorative. */}
      <meter
        className="sr-only"
        aria-label="Monthly API budget used"
        min={0}
        max={cap}
        value={spent}
      />
      <div className="h-1 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
        <div className={cls("h-full rounded-full", tone)} style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="tabular text-xs text-secondary">
        {usd(spent)} of {usd(cap)}
        {ratio >= 1 && " · API calls are paused"}
      </span>
    </div>
  );
}

const ICON = { pdf_page: FileText, transcript: Mic, message: Mail } as const;

export function citationLocation(c: Citation): string {
  const a = c.anchor;
  if (a.kind === "pdf_page") return `p. ${a.page}`;
  if (a.kind === "transcript") {
    const s = Math.floor(a.startMs / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  if (a.kind === "github") return `#${a.number}`;
  return "";
}

/** Inline pill after the sentence it supports; opens the source viewer at the anchor (§5.7). */
export function CitationChip({
  index,
  citation,
  onOpen,
}: {
  index: number;
  citation: Citation;
  onOpen: (c: Citation) => void;
}) {
  const Icon = ICON[citation.anchor.kind as keyof typeof ICON] ?? FileText;
  const where = citationLocation(citation);
  const name = `Source ${index}, ${citation.title}${where ? `, ${where}` : ""}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(citation)}
      aria-label={name}
      title={name}
      className="mx-0.5 inline-flex h-5 translate-y-[-1px] items-center gap-1 rounded-full bg-layer-subtle px-2 align-middle text-xs font-medium text-secondary transition-colors duration-[180ms] ease-ui hover:bg-layer-strong"
    >
      <Icon size={12} aria-hidden />
      {index}
    </button>
  );
}

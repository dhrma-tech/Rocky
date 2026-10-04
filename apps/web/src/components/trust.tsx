import type { Citation } from "@rocky/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, FileText, Mail, Mic, ShieldCheck } from "lucide-react";
import { cls } from "./ui.tsx";

/** "Local only" or "Data leaves device" (§5.7). Clicking opens Privacy settings. */
export function LocalBadge({ localOnly }: { localOnly: boolean | undefined }) {
  if (localOnly === undefined) return null;
  return (
    <Link
      to="/settings"
      className={cls(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium no-underline",
        localOnly ? "bg-accent-soft text-primary" : "bg-layer-subtle text-warning",
      )}
      title={
        localOnly
          ? "Every model call stays on this machine."
          : "Some tasks may call an API model. Turn on local-only mode in Settings to keep everything on this machine."
      }
    >
      {localOnly ? <ShieldCheck size={14} aria-hidden /> : <ArrowUpRight size={14} aria-hidden />}
      {localOnly ? "Local only" : "Data leaves device"}
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

import type { AnswerSentence, Citation, PathInfo } from "@rocky/contracts";
import { SafeText } from "./SafeText.tsx";
import { CitationChip } from "./trust.tsx";

/**
 * Verified sentences with numbered citation chips (§5.5), shared by Ask, briefs and routines.
 * Partially supported sentences carry a marker; unsupported ones only appear struck through.
 */
export function Sentences({
  answer,
  onOpen,
  className = "font-answer text-base leading-[26px] text-primary",
}: {
  answer: AnswerSentence[];
  onOpen: (c: Citation) => void;
  className?: string;
}) {
  const index = new Map<string, number>();
  const n = (c: Citation) => {
    if (!index.has(c.chunkId)) index.set(c.chunkId, index.size + 1);
    return index.get(c.chunkId) as number;
  };
  return (
    <p className={className}>
      {answer.map((s) => (
        <span
          key={s.i}
          className={s.status === "unsupported" ? "line-through opacity-60" : undefined}
        >
          <SafeText text={s.text} />
          {s.citations.map((c) => (
            <CitationChip key={c.chunkId} index={n(c)} citation={c} onOpen={onOpen} />
          ))}
          {s.status === "partial" && (
            <span className="ml-1 text-xs text-warning" title={s.reason}>
              (partially supported)
            </span>
          )}{" "}
        </span>
      ))}
    </p>
  );
}

/** "Local · model" or "API · model" with the fallback reason (the egress indicator per view). */
export function PathLine({ path }: { path: PathInfo | null }) {
  if (!path) return null;
  return (
    <p className="font-mono text-xs text-tertiary">
      {path.local ? "Local" : "API"} · {path.model}
      {path.fallbackReason && ` (fallback: ${path.fallbackReason.replace(/_/g, " ")})`}
    </p>
  );
}

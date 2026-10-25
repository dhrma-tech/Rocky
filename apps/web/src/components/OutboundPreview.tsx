import type { OutboundPreview as Preview, SensitiveTag } from "@rocky/contracts";
import { CloudUpload, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/index.tsx";

/**
 * The outbound preview (roadmap M4, D-020, D-068): exactly what a cloud model would be sent for
 * this question, shown before anything leaves. Passages that look sensitive are tagged (pattern
 * checks, so they may miss something; the full text is here to read). Sending needs a click;
 * nothing goes out otherwise, and the offer lapses after ten minutes.
 */

export const TAG_WORD: Record<SensitiveTag, string> = {
  email: "Email address",
  phone: "Phone number",
  card_number: "Card number",
  iban: "Bank account",
  id_number: "ID number",
  secret: "Password or key",
};

const REASON: Record<Preview["reason"], string> = {
  asked: "You chose the cloud for this question. Nothing has been sent yet.",
  not_found:
    "Rocky's model on this computer found no answer it could check. A cloud model could try with the passages below.",
  low_verification:
    "Most of what Rocky's model on this computer wrote didn't pass the check. A cloud model could try with the passages below.",
};

const provider = (model: string) => {
  const [p, m] = model.split("/");
  return `${p === "anthropic" ? "Anthropic" : p === "google" ? "Google" : p} (${m})`;
};

export function OutboundPreview({
  preview,
  question,
  onSend,
  onDecline,
  sending,
}: {
  preview: Preview;
  question: string;
  onSend: () => void;
  /** "Keep it on this computer": answer locally instead, or just close the offer. */
  onDecline?: () => void;
  sending: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const expired = now >= preview.expiresAt;
  const tags = [...new Set(preview.passages.flatMap((p) => p.tags))];
  const n = preview.passages.length;
  return (
    <section className="rk-outbound" aria-label="What would be sent">
      <h3 className="rk-outbound__title">
        <CloudUpload size={16} strokeWidth={1.5} aria-hidden /> Send to {provider(preview.model)}?
      </h3>
      <p className="rk-small rk-outbound__why">{REASON[preview.reason]}</p>
      <p className="rk-small rk-muted">
        It would get your question and {n === 1 ? "this passage" : `these ${n} passages`}
        {preview.verifier && preview.verifier !== preview.model
          ? `; the check goes to ${provider(preview.verifier)}`
          : ""}
        . Once sent, it's handled under that provider's own terms.
      </p>
      {tags.length > 0 && (
        <p className="rk-outbound__warn rk-small" role="note">
          <ShieldAlert size={16} strokeWidth={1.5} aria-hidden /> Looks like it includes:{" "}
          {tags.map((t) => TAG_WORD[t]).join(", ")}. Read the passages before sending.
        </p>
      )}
      <details className="rk-outbound__details">
        <summary>Show {n === 1 ? "the passage" : `all ${n} passages`} and the question</summary>
        <p className="rk-outbound__question">
          <span className="rk-muted">Question:</span> {question}
        </p>
        <ol className="rk-outbound__passages">
          {preview.passages.map((p) => (
            <li key={p.chunkId} className="rk-outbound__passage">
              <p className="rk-small rk-outbound__source">
                {p.title}
                {p.tags.map((t) => (
                  <span key={t} className="rk-chip rk-chip--warning">
                    {TAG_WORD[t]}
                  </span>
                ))}
              </p>
              <blockquote className="rk-outbound__text">{p.text}</blockquote>
            </li>
          ))}
        </ol>
      </details>
      <div className="rk-outbound__actions">
        {expired ? (
          <p className="rk-small rk-muted">This offer has lapsed. Ask again to see it.</p>
        ) : (
          <Button variant="primary" dense onClick={onSend} loading={sending && "Sending…"}>
            Send {n === 1 ? "1 passage" : `${n} passages`}
          </Button>
        )}
        {onDecline && (
          <Button variant="tertiary" dense onClick={onDecline} disabled={sending}>
            Keep it on this computer
          </Button>
        )}
      </div>
    </section>
  );
}

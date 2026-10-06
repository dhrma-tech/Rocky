import type { AnswerSentence, AskResult, Citation } from "@rocky/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUp, CircleCheck, CircleSlash, Square } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ApiError, api, askStream } from "../api.ts";
import { SafeText } from "../components/SafeText.tsx";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { CitationChip } from "../components/trust.tsx";
import { Toggle } from "../components/ui.tsx";

interface Turn {
  id: number;
  question: string;
  /** Sentences drafted so far (streaming), replaced by the verified answer at the end. */
  drafts: string[];
  result?: AskResult;
  error?: ApiError;
}

/** Verification state line above each answer (§5.5): a product differentiator, always visible. */
function VerificationLine({ result }: { result: AskResult }) {
  const base = "flex items-center gap-1.5 font-mono text-xs";
  if (result.notFound)
    return (
      <p className={`${base} text-secondary`}>
        <CircleSlash size={14} aria-hidden /> Not found in your sources
      </p>
    );
  const sources = new Set(result.answer.flatMap((s) => s.citations.map((c) => c.documentId))).size;
  const weak = result.answer.filter((s) => s.status !== "supported").length;
  const local = result.path?.local;
  return (
    <p className={`${base} ${weak ? "text-warning" : "text-success"}`}>
      {weak ? <AlertTriangle size={14} aria-hidden /> : <CircleCheck size={14} aria-hidden />}
      {weak
        ? `${weak} statement${weak > 1 ? "s" : ""} only partly verified`
        : `Checked against ${sources} source${sources > 1 ? "s" : ""}`}
      {local && " · verified locally (lower confidence)"}
    </p>
  );
}

function PathChip({ result }: { result: AskResult }) {
  const p = result.path;
  if (!p) return null;
  return (
    <p className="font-mono text-xs text-tertiary">
      {p.local ? "Local" : "API"} · {p.model}
      {p.fallbackReason && ` (fallback: ${p.fallbackReason.replace(/_/g, " ")})`}
      {!p.local && ` · $${result.usage.costUsd.toFixed(4)}`}
    </p>
  );
}

function Answer({ result, onOpen }: { result: AskResult; onOpen: (c: Citation) => void }) {
  const index = new Map<string, number>();
  const n = (c: Citation) => {
    if (!index.has(c.chunkId)) index.set(c.chunkId, index.size + 1);
    return index.get(c.chunkId) as number;
  };
  if (result.notFound) {
    return (
      <div className="space-y-2">
        <p className="font-answer text-base leading-[26px]">Not found in your sources.</p>
        {result.closestMatches.length > 0 && (
          <p className="text-sm text-secondary">
            Closest matches: {result.closestMatches.map((m) => m.title).join(" · ")}
          </p>
        )}
      </div>
    );
  }
  return (
    <p className="font-answer text-base leading-[26px] text-primary">
      {result.answer.map((s: AnswerSentence) => (
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

const POLICY_HELP: Record<string, string> = {
  BUDGET_EXCEEDED: "Raise the cap in Settings → Budget, or turn on local-only mode.",
  EGRESS_BLOCKED: "Local-only mode is on, so API models are blocked.",
  MISSING_API_KEY: "Add an API key in Settings → Models, or turn on local-only mode.",
  TASK_NEEDS_API: "This needs an API model. Turn off local-only mode to use it.",
};

export function AskPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [showFlagged, setShowFlagged] = useState(false);
  const [open, setOpen] = useState<Citation | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });

  // Follow the conversation as turns arrive and update.
  useEffect(() => {
    if (turns.length) bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const update = (id: number, f: (t: Turn) => Turn) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? f(t) : t)));

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const question = text.trim();
    if (!question || busy) return;
    const id = Date.now();
    setTurns((ts) => [...ts, { id, question, drafts: [] }]);
    setText("");
    setBusy(true);
    abort.current = new AbortController();
    try {
      const result = await askStream(
        { question, showFlagged },
        (ev) => {
          if (ev.type === "draft_sentence")
            update(id, (t) => ({ ...t, drafts: [...t.drafts, ev.text] }));
        },
        abort.current.signal,
      );
      update(id, (t) => ({ ...t, result }));
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError"))
        update(id, (t) => ({
          ...t,
          error: err instanceof ApiError ? err : new ApiError(0, "NETWORK", String(err)),
        }));
    } finally {
      setBusy(false);
      abort.current = null;
      void qc.invalidateQueries({ queryKey: ["usage"] });
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const empty = turns.length === 0;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {empty ? (
            <div className="mx-auto flex h-full max-w-[720px] flex-col justify-center pb-24">
              <h1 className="text-2xl font-normal leading-8 text-primary">
                What do you want to know?
              </h1>
              <p className="mt-1 text-sm text-secondary">
                Answers come only from your sources, with a citation on every statement.
              </p>
            </div>
          ) : (
            <ol
              className="mx-auto max-w-[720px] space-y-6 py-8"
              aria-live="polite"
              aria-busy={busy}
            >
              {turns.map((t) => (
                <li key={t.id} className="space-y-3">
                  <p className="ml-auto w-fit max-w-[80%] rounded-lg rounded-br-xs bg-accent-soft px-4 py-2 text-primary">
                    {t.question}
                  </p>
                  {t.result ? (
                    <div className="space-y-2">
                      <VerificationLine result={t.result} />
                      <Answer result={t.result} onOpen={setOpen} />
                      <PathChip result={t.result} />
                    </div>
                  ) : t.error ? (
                    <div role="alert" className="rounded-lg bg-raised p-4 shadow-raised-sm">
                      <p className="flex items-center gap-2 text-sm font-medium text-danger">
                        <AlertTriangle size={16} aria-hidden /> {t.error.message}
                      </p>
                      {POLICY_HELP[t.error.code] && (
                        <p className="mt-1 text-sm text-secondary">{POLICY_HELP[t.error.code]}</p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2 text-secondary">
                      <p className="font-mono text-xs">
                        {t.drafts.length ? "Verifying each statement…" : "Searching your sources…"}
                      </p>
                      {t.drafts.length > 0 && (
                        <p className="font-answer leading-[26px]">
                          <SafeText text={t.drafts.join(" ")} />
                        </p>
                      )}
                      <span
                        className="pulse-dot inline-block size-2 rounded-full bg-accent-strong"
                        aria-hidden
                      />
                    </div>
                  )}
                </li>
              ))}
              <div ref={bottom} />
            </ol>
          )}
        </div>

        <form onSubmit={submit} className="mx-auto w-full max-w-[760px] px-4 pb-4">
          <div className="rounded-lg bg-raised p-3 shadow-raised-md focus-within:shadow-[var(--composer-glow),var(--shadow-raised-md)]">
            <label htmlFor="composer" className="sr-only">
              Ask about your work
            </label>
            <textarea
              id="composer"
              ref={input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder="Ask about your work…"
              className="max-h-60 min-h-[52px] w-full resize-none bg-transparent text-base leading-6 text-primary outline-none placeholder:text-tertiary"
            />
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-3 text-xs text-secondary">
                <span className="rounded-full bg-layer-subtle px-3 py-1">Everything</span>
                {settings.data && (
                  <span>
                    {settings.data.localOnly ? "Local models" : "Claude via API, local fallback"}
                  </span>
                )}
              </div>
              {busy ? (
                <button
                  type="button"
                  aria-label="Stop"
                  onClick={() => abort.current?.abort()}
                  className="inline-flex size-11 items-center justify-center rounded-full"
                >
                  <span className="inline-flex size-8 items-center justify-center rounded-full bg-accent text-on-accent">
                    <Square size={14} aria-hidden />
                  </span>
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label="Send"
                  disabled={!text.trim()}
                  className="group inline-flex size-11 items-center justify-center rounded-full disabled:cursor-not-allowed"
                >
                  <span className="inline-flex size-8 items-center justify-center rounded-full bg-accent text-on-accent group-hover:bg-accent-hover group-disabled:bg-layer-subtle group-disabled:text-tertiary">
                    <ArrowUp size={16} aria-hidden />
                  </span>
                </button>
              )}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between px-1">
            <p className="text-xs text-tertiary">
              Enter to send · Shift+Enter for a new line · / to focus
            </p>
            <div className="w-56">
              <Toggle label="Show flagged" checked={showFlagged} onChange={setShowFlagged} />
            </div>
          </div>
        </form>
      </div>

      {open && (
        <div className="fixed inset-0 z-30 lg:relative lg:z-20">
          <SourceViewer citation={open} onClose={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}

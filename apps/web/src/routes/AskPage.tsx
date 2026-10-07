import type { AskResult, Citation } from "@rocky/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  CircleCheck,
  CircleSlash,
  Square,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ApiError, api, askStream } from "../api.ts";
import { CreateIssueButton } from "../components/CreateIssue.tsx";
import { SafeText } from "../components/SafeText.tsx";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { cls, Toggle } from "../components/ui.tsx";
import { Sentences } from "../components/verified.tsx";

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
  return <Sentences answer={result.answer} onOpen={onOpen} />;
}

export const POLICY_HELP: Record<string, string> = {
  BUDGET_EXCEEDED: "Raise the cap in Settings → Budget, or turn on local-only mode.",
  EGRESS_BLOCKED: "Local-only mode is on, so API models are blocked.",
  MISSING_API_KEY: "Add an API key in Settings → Models, or turn on local-only mode.",
  TASK_NEEDS_API: "This needs an API model. Turn off local-only mode to use it.",
};

/** /ask, optionally with ?q= from the Home composer (asked on arrival). */
export function AskPage() {
  const { q } = useSearch({ from: "/ask" });
  return <AskView key={q ?? ""} {...(q ? { initialQuestion: q } : {})} />;
}

/**
 * The verified Ask thread (§5.5). On the Ask page the scope chip picks Everything or one or more
 * notebooks (several = a cross-notebook question); inside a notebook the scope is fixed.
 */
export function AskView({
  notebookIds: fixed,
  heading = "What do you want to know?",
  grounding = "Answers come only from your sources, with a citation on every statement.",
  initialQuestion,
}: {
  notebookIds?: string[];
  heading?: string;
  grounding?: string;
  initialQuestion?: string;
} = {}) {
  const [scopeIds, setScopeIds] = useState<string[]>(fixed ?? []);
  const notebookIds = fixed ?? scopeIds;
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

  async function submit(e?: FormEvent, override?: string) {
    e?.preventDefault();
    const question = (override ?? text).trim();
    if (!question || busy) return;
    const id = Date.now();
    setTurns((ts) => [...ts, { id, question, drafts: [] }]);
    setText("");
    setBusy(true);
    abort.current = new AbortController();
    try {
      const result = await askStream(
        { question, showFlagged, ...(notebookIds.length ? { scope: { notebookIds } } : {}) },
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

  // A question handed over from Home is asked once on arrival.
  const asked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per initial question
  useEffect(() => {
    if (initialQuestion && !asked.current) {
      asked.current = true;
      void submit(undefined, initialQuestion);
    }
  }, [initialQuestion]);

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
              <h1 className="text-2xl font-normal leading-8 text-primary">{heading}</h1>
              <p className="mt-1 text-sm text-secondary">{grounding}</p>
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
                      <div className="flex flex-wrap items-center gap-2">
                        <PathChip result={t.result} />
                        <CreateIssueButton question={t.question} result={t.result} />
                      </div>
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
                <ScopeChip value={notebookIds} onChange={setScopeIds} locked={Boolean(fixed)} />
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

/** Scope chip (§5.4): Everything, or one or more notebooks. A union of notebooks is a cross-notebook question. */
function ScopeChip({
  value,
  onChange,
  locked,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const notebooks = useQuery({ queryKey: ["notebooks"], queryFn: api.notebooks });
  const names = (notebooks.data?.notebooks ?? [])
    .filter((n) => value.includes(n.id))
    .map((n) => n.name);
  const label =
    value.length === 0
      ? "Everything"
      : names.length > 1
        ? `${names.length} notebooks`
        : (names[0] ?? "Notebook");
  if (locked)
    return <span className="rounded-full bg-accent-soft px-3 py-1 text-primary">{label}</span>;
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <span className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cls(
          "inline-flex min-h-8 items-center gap-1 rounded-full px-3 py-1",
          value.length ? "bg-accent-soft text-primary" : "bg-layer-subtle",
        )}
      >
        {label} <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <fieldset
          aria-label="Search scope"
          className="absolute bottom-10 left-0 z-50 m-0 w-64 rounded-lg border-0 bg-overlay p-2 shadow-float"
        >
          <button
            type="button"
            onClick={() => {
              onChange([]);
              setOpen(false);
            }}
            className="flex min-h-10 w-full items-center rounded-md px-2 text-left text-sm hover:bg-layer-subtle"
          >
            Everything
          </button>
          {(notebooks.data?.notebooks ?? []).map((n) => (
            <label
              key={n.id}
              className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-layer-subtle"
            >
              <input
                type="checkbox"
                checked={value.includes(n.id)}
                onChange={() => toggle(n.id)}
                className="size-4 shrink-0 accent-[var(--accent-strong)]"
              />
              <span className="truncate">{n.name}</span>
              {n.localOnly && <span className="ml-auto text-xs text-tertiary">local</span>}
            </label>
          ))}
          {notebooks.data?.notebooks.length === 0 && (
            <p className="px-2 py-1 text-xs text-tertiary">No notebooks yet.</p>
          )}
        </fieldset>
      )}
    </span>
  );
}

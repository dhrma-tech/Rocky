import type { AskResult, Citation, RockyEvent } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowUp,
  BookOpen,
  CircleSlash,
  Copy,
  History,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Pebble } from "../agent-ui/Pebble.tsx";
import { StatusChip } from "../agent-ui/StatusChip.tsx";
import { Receipt } from "../agent-ui/work.tsx";
import { ApiError, api, askStream, conversations, onboarding, projects } from "../api.ts";
import { CreateIssueButton } from "../components/CreateIssue.tsx";
import { OutboundPreview } from "../components/OutboundPreview.tsx";
import { SafeText } from "../components/SafeText.tsx";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { Sentences } from "../components/verified.tsx";
import {
  Banner,
  Button,
  Drawer,
  IconButton,
  Segmented,
  Skeleton,
  Switch,
  Tabs,
  useToast,
} from "../ui/index.tsx";
import "./chat.css";

/**
 * Chat and workspace (UI spec 5, D-053): a verified conversation beside a work pane. In today's
 * engine a "run" is one question (D-017): Rocky searches, drafts, checks every statement against
 * its source, and answers or says "Not found in your sources". Conversations are saved; deleting
 * a source removes the turns that quote it.
 */

interface Turn {
  key: string;
  question: string;
  /** Live while the answer streams. */
  phase: "searching" | "checking" | "done" | "failed";
  startedAt: number;
  passages: number;
  documents: number;
  drafts: string[];
  checked: number;
  result?: AskResult;
  error?: ApiError;
  /** The user closed the cloud offer under a weak local answer. */
  declined?: boolean;
}

type Route = "local" | "cloud";

export const POLICY_HELP: Record<string, string> = {
  BUDGET_EXCEEDED: "Raise the cap in Settings → Model, or turn on local-only mode.",
  EGRESS_BLOCKED: "Local-only mode is on, so online models are blocked.",
  MISSING_API_KEY: "Add an API key in Settings → Model, or turn on local-only mode.",
  TASK_NEEDS_API: "This needs an online model. Turn off local-only mode to use it.",
  CLOUD_NEEDS_CONSENT: "Nothing was sent. Pick Cloud for this question to see what it would send.",
  TASK_NEEDS_CLOUD: "Rocky is set to local first. Switch to cloud first in Settings → Model.",
  CONSENT_INVALID: "Nothing was sent. Ask again to see the passages.",
};

const sourcesOf = (r: AskResult) =>
  new Set([
    ...r.answer.flatMap((s) => s.citations.map((c) => c.documentId)),
    ...r.closestMatches.map((m) => m.documentId),
  ]).size;

/** /ask: the chat screen. ?q= asks on arrival, ?c= reopens a conversation, ?project= scopes it. */
export function AskPage() {
  const search = useSearch({ from: "/ask" });
  const project = useQuery({
    queryKey: ["project", search.project],
    queryFn: () => projects.get(search.project as string),
    enabled: Boolean(search.project),
  });
  if (search.project && project.isLoading)
    return (
      <div className="rk-page">
        <Skeleton rows={3} height={52} label="Loading the project" />
      </div>
    );
  const p = project.data;
  return (
    <ChatView
      // Remount only when the scope changes; the chat follows ?c and ?q itself, so recording a new
      // conversation in the URL never interrupts an answer that is still streaming.
      key={search.project ?? ""}
      conversationId={search.c}
      initialQuestion={search.q}
      notebookIds={p?.notebookId ? [p.notebookId] : undefined}
      crumbs={
        p ? (
          <>
            <Link to="/projects">Projects</Link> /{" "}
            <Link to="/projects/$id" params={{ id: p.id }}>
              {p.name}
            </Link>{" "}
            / Chat
          </>
        ) : (
          "Chat"
        )
      }
      projectId={p?.id}
    />
  );
}

/** Inside a notebook: the same chat, scoped to it, without the page header. */
export function AskView({
  notebookIds,
  heading,
  grounding,
}: {
  notebookIds?: string[];
  heading?: string;
  grounding?: string;
}) {
  return (
    <ChatView
      notebookIds={notebookIds}
      embedded
      {...(heading ? { heading } : {})}
      {...(grounding ? { grounding } : {})}
    />
  );
}

function ChatView({
  conversationId: openId,
  initialQuestion,
  notebookIds,
  crumbs,
  projectId,
  embedded = false,
  heading = "What do you want to know?",
  grounding = "Answers come only from your sources, with a citation on every statement.",
}: {
  conversationId?: string | undefined;
  initialQuestion?: string | undefined;
  notebookIds?: string[] | undefined;
  crumbs?: ReactNode;
  projectId?: string | undefined;
  embedded?: boolean;
  heading?: string;
  grounding?: string;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [convId, setConvId] = useState<string | undefined>(openId);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [showFlagged, setShowFlagged] = useState(false);
  // The per-question switch (D-068); until the user picks, the routing mode decides.
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [picked, setPicked] = useState<Route | null>(null);
  const cloudOn = Boolean(
    settings.data && !settings.data.localOnly && settings.data.secrets.anthropic,
  );
  const route: Route = !cloudOn
    ? "local"
    : (picked ?? (settings.data?.routing.mode === "cloud_first" ? "cloud" : "local"));
  const [pane, setPane] = useState(
    () => !embedded && window.matchMedia("(min-width: 1200px)").matches,
  );
  const [paneTab, setPaneTab] = useState("activity");
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Citation | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = turns.some((t) => t.phase === "searching" || t.phase === "checking");

  // Conversations this view created: their turns are already on screen, so never reload them.
  const mine = useRef(new Set<string>());
  const reopening = Boolean(openId) && !mine.current.has(openId as string);
  const saved = useQuery({
    queryKey: ["conversation", openId],
    queryFn: () => conversations.get(openId as string),
    enabled: reopening,
  });
  // Another conversation picked (history, New conversation): start from it, or from empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the URL picks another one
  useEffect(() => {
    if (openId === convId || (openId && mine.current.has(openId))) return;
    abort.current?.abort();
    setConvId(openId);
    setTurns([]);
    setSelected(null);
  }, [openId]);
  // A reopened conversation shows its saved turns once.
  useEffect(() => {
    if (!saved.data) return;
    setTurns(
      saved.data.history.map((h) => ({
        key: h.id,
        question: h.question,
        phase: "done",
        startedAt: h.createdAt,
        passages: 0,
        documents: sourcesOf(h.result),
        drafts: [],
        checked: h.result.answer.length,
        result: h.result,
      })),
    );
  }, [saved.data]);

  useEffect(() => {
    if (turns.length) bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const stop = () => abort.current?.abort();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        input.current?.focus();
      }
      // Ctrl/Cmd+. stops the run; Esc closes the pane first and never stops a run.
      if ((e.ctrlKey || e.metaKey) && e.key === ".") {
        e.preventDefault();
        abort.current?.abort();
      }
      if (e.key === "Escape" && open) setOpen(null);
      else if (e.key === "Escape" && pane && !window.matchMedia("(min-width: 900px)").matches)
        setPane(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pane]);

  const update = (key: string, f: (t: Turn) => Turn) =>
    setTurns((ts) => ts.map((t) => (t.key === key ? f(t) : t)));

  /** `consent` sends a previewed question to the cloud; `via` overrides the switch once. */
  async function send(
    question: string,
    replacing?: string,
    how: { consent?: string; via?: Route } = {},
  ) {
    if (!question || busy) return;
    const key = `t${Date.now()}`;
    setTurns((ts) => [
      ...ts.filter((t) => t.key !== replacing),
      {
        key,
        question,
        phase: "searching",
        startedAt: Date.now(),
        passages: 0,
        documents: 0,
        drafts: [],
        checked: 0,
      },
    ]);
    setSelected(key);
    setText("");
    abort.current = new AbortController();
    try {
      // The conversation is created with the first question, so empty chats are never saved.
      let id = convId;
      if (!id) {
        id = (await conversations.create(notebookIds?.length ? { notebookIds } : {})).id;
        mine.current.add(id);
        setConvId(id);
        if (!embedded)
          void navigate({
            to: "/ask",
            search: { c: id, ...(projectId ? { project: projectId } : {}) },
            replace: true,
          });
      }
      const result = await askStream(
        {
          question,
          showFlagged,
          conversationId: id,
          ...(notebookIds?.length ? { scope: { notebookIds } } : {}),
          ...(how.consent ? { consent: how.consent } : { route: how.via ?? route }),
        },
        (ev) => {
          if (ev.type === "retrieval")
            update(key, (t) => ({
              ...t,
              passages: ev.chunks.length,
              documents: new Set(ev.chunks.map((c) => c.docTitle)).size,
            }));
          if (ev.type === "draft_sentence")
            update(key, (t) => ({ ...t, phase: "checking", drafts: [...t.drafts, ev.text] }));
          if (ev.type === "verified") update(key, (t) => ({ ...t, checked: t.checked + 1 }));
        },
        abort.current.signal,
      );
      update(key, (t) => ({ ...t, phase: "done", result, documents: sourcesOf(result) }));
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError")
        update(key, (t) => ({
          ...t,
          phase: "failed",
          error: new ApiError(0, "STOPPED", "Stopped."),
        }));
      else
        update(key, (t) => ({
          ...t,
          phase: "failed",
          error: err instanceof ApiError ? err : new ApiError(0, "NETWORK", String(err)),
        }));
    } finally {
      abort.current = null;
      void qc.invalidateQueries({ queryKey: ["usage"] });
    }
  }

  // A question handed over from Today, onboarding or a starter chip is asked once on arrival.
  const asked = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per initial question
  useEffect(() => {
    if (initialQuestion && asked.current !== initialQuestion) {
      asked.current = initialQuestion;
      void send(initialQuestion);
    }
  }, [initialQuestion]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    void send(text.trim());
  };
  const lastQuestion = [...turns].reverse()[0]?.question;
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    // Up arrow in an empty composer brings the last question back to edit.
    if (e.key === "ArrowUp" && !text && lastQuestion) {
      e.preventDefault();
      setText(lastQuestion);
    }
  };

  const copy = (s: string) =>
    void navigator.clipboard.writeText(s).then(
      () => toast({ text: "Copied." }),
      () => toast({ text: "Couldn't copy." }),
    );

  const current = turns.find((t) => t.key === selected) ?? turns.at(-1);
  const empty = turns.length === 0 && !(reopening && saved.isLoading);

  return (
    <div className="rk-chat" data-embedded={embedded || undefined} data-pane={pane || undefined}>
      <section className="rk-chat__col" aria-label="Conversation">
        {!embedded && (
          <header className="rk-chat__head">
            <p className="rk-small rk-chat__crumbs">{crumbs}</p>
            <div className="rk-chat__tools">
              <IconButton label="Past conversations" onClick={() => setHistoryOpen(true)}>
                <History size={20} strokeWidth={1.5} aria-hidden />
              </IconButton>
              <IconButton
                label="New conversation"
                onClick={() =>
                  void navigate({ to: "/ask", search: projectId ? { project: projectId } : {} })
                }
              >
                <Plus size={20} strokeWidth={1.5} aria-hidden />
              </IconButton>
              <IconButton
                label={pane ? "Close the work pane" : "Open the work pane"}
                onClick={() => setPane((p) => !p)}
              >
                {pane ? (
                  <PanelRightClose size={20} strokeWidth={1.5} aria-hidden />
                ) : (
                  <PanelRightOpen size={20} strokeWidth={1.5} aria-hidden />
                )}
              </IconButton>
            </div>
          </header>
        )}

        <div className="rk-chat__log">
          {reopening && saved.isLoading && <HistorySkeleton />}
          {saved.isError && (
            <Banner tone="error" title="Couldn't open this conversation.">
              {saved.error.message}
            </Banner>
          )}
          {empty && (
            <EmptyChat heading={heading} grounding={grounding} onPick={(q) => void send(q)} />
          )}
          {turns.length > 0 && (
            <ol className="rk-chat__turns" aria-live="polite" aria-busy={busy}>
              {turns.map((t) => (
                <li key={t.key} className="rk-turn">
                  <UserMessage
                    text={t.question}
                    onCopy={() => copy(t.question)}
                    onEdit={() => {
                      setText(t.question);
                      input.current?.focus();
                    }}
                  />
                  <RockyMessage
                    turn={t}
                    selected={t.key === current?.key}
                    onOpen={(c) => setOpen(c)}
                    onSelect={() => {
                      setSelected(t.key);
                      setPaneTab("activity");
                      setPane(true);
                    }}
                    onStop={stop}
                    onRetry={() => void send(t.question, t.key)}
                    onCopy={copy}
                    busy={busy}
                    onSendCloud={(consent) => void send(t.question, t.key, { consent })}
                    onKeepLocal={() =>
                      t.result?.awaitingConsent
                        ? void send(t.question, t.key, { via: "local" })
                        : update(t.key, (x) => ({ ...x, declined: true }))
                    }
                  />
                </li>
              ))}
            </ol>
          )}
          <div ref={bottom} />
        </div>

        <Composer
          text={text}
          setText={setText}
          busy={busy}
          inputRef={input}
          onSubmit={submit}
          onKeyDown={onKeyDown}
          onStop={stop}
          showFlagged={showFlagged}
          setShowFlagged={setShowFlagged}
          notebookIds={notebookIds}
          route={route}
          setRoute={cloudOn ? setPicked : undefined}
        />
      </section>

      {pane && (
        <aside className="rk-pane" aria-label="Work pane">
          <div className="rk-pane__head">
            <h2 className="rk-h3">Work</h2>
            <IconButton label="Close the work pane" onClick={() => setPane(false)}>
              <PanelRightClose size={20} strokeWidth={1.5} aria-hidden />
            </IconButton>
          </div>
          <Tabs
            label="Work pane"
            value={paneTab}
            onChange={setPaneTab}
            tabs={[
              { id: "activity", title: "Activity", panel: <ActivityPanel turn={current} /> },
              {
                id: "sources",
                title: "Sources",
                panel: <SourcesPanel turns={turns} onOpen={setOpen} />,
              },
              { id: "memory", title: "Memory", panel: <MemoryPanel /> },
            ]}
          />
        </aside>
      )}

      {open && (
        <div className="rk-chat__viewer">
          <SourceViewer citation={open} onClose={() => setOpen(null)} />
        </div>
      )}

      {!embedded && (
        <HistoryDrawer
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          currentId={convId}
          onPick={(id) => {
            setHistoryOpen(false);
            void navigate({ to: "/ask", search: { c: id } });
          }}
        />
      )}
    </div>
  );
}

// --- Messages ---

function UserMessage({
  text,
  onCopy,
  onEdit,
}: {
  text: string;
  onCopy: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="rk-msg rk-msg--user">
      <p className="rk-msg__body">{text}</p>
      <div className="rk-msg__actions">
        <IconButton label="Copy" dense onClick={onCopy}>
          <Copy size={16} strokeWidth={1.5} aria-hidden />
        </IconButton>
        <IconButton label="Edit and ask again" dense onClick={onEdit}>
          <Pencil size={16} strokeWidth={1.5} aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}

function RockyMessage({
  turn: t,
  selected,
  onOpen,
  onSelect,
  onStop,
  onRetry,
  onCopy,
  busy,
  onSendCloud,
  onKeepLocal,
}: {
  turn: Turn;
  selected: boolean;
  onOpen: (c: Citation) => void;
  onSelect: () => void;
  onStop: () => void;
  onRetry: () => void;
  onCopy: (s: string) => void;
  busy: boolean;
  onSendCloud: (consent: string) => void;
  onKeepLocal: () => void;
}) {
  if (t.phase === "searching" || t.phase === "checking")
    return <RunCard turn={t} onStop={onStop} onOpen={onSelect} />;
  if (t.error) {
    const stopped = t.error.code === "STOPPED";
    return (
      <div className="rk-msg rk-msg--rocky" role={stopped ? undefined : "alert"}>
        <Pebble size={24} state={stopped ? null : "failed"} label="Rocky" />
        <div className="rk-msg__body">
          <p className="rk-msg__error">
            {stopped
              ? "Stopped before answering."
              : POLICY_HELP[t.error.code]
                ? t.error.message
                : "Couldn't send."}
          </p>
          <p className="rk-small rk-muted">
            {POLICY_HELP[t.error.code] ?? (stopped ? "Nothing was saved." : t.error.message)}
          </p>
          <div className="rk-msg__inline-actions">
            <Button dense onClick={onRetry}>
              Retry
            </Button>
            <Button dense variant="tertiary" onClick={() => onCopy(t.question)}>
              Copy message
            </Button>
          </div>
        </div>
      </div>
    );
  }
  const r = t.result as AskResult;
  const preview = r.outbound && !t.declined && (
    <OutboundPreview
      preview={r.outbound}
      question={t.question}
      sending={busy}
      onSend={() => onSendCloud(r.outbound?.token ?? "")}
      onDecline={onKeepLocal}
    />
  );
  // Cloud picked: nothing answered yet, only what would be sent.
  if (r.awaitingConsent)
    return (
      <div className="rk-msg rk-msg--rocky" data-selected={selected || undefined}>
        <Pebble size={24} state="needs_approval" label="Rocky" />
        <div className="rk-msg__body">{preview}</div>
      </div>
    );
  const answerText = r.notFound
    ? "Not found in your sources."
    : r.answer.map((s) => s.text).join(" ");
  const n = sourcesOf(r);
  return (
    <div className="rk-msg rk-msg--rocky" data-selected={selected || undefined}>
      <Pebble size={24} label="Rocky" />
      <div className="rk-msg__body">
        <Verification result={r} />
        {r.notFound ? (
          <>
            <p className="rk-msg__answer">Not found in your sources.</p>
            {r.closestMatches.length > 0 && (
              <p className="rk-small rk-muted">
                Closest matches: {r.closestMatches.map((m) => m.title).join(" · ")}
              </p>
            )}
          </>
        ) : (
          <Sentences answer={r.answer} onOpen={onOpen} className="rk-msg__answer" />
        )}
        <Receipt event={receiptFor(r, n)} onOpen={onSelect} />
        {preview}
        <div className="rk-msg__meta">
          <ModelLine result={r} />
          <CreateIssueButton question={t.question} result={r} />
        </div>
      </div>
      <div className="rk-msg__actions">
        <IconButton label="Copy answer" dense onClick={() => onCopy(answerText)}>
          <Copy size={16} strokeWidth={1.5} aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}

/** The ledger's receipt for this answer, drawn locally from the result. */
function receiptFor(r: AskResult, n: number): Extract<RockyEvent, { kind: "receipt" }> {
  return {
    kind: "receipt",
    seq: 0,
    at: 0,
    runId: null,
    tool: "Ask",
    verb: r.notFound ? "found nothing in" : "cited",
    count: n,
    unit: n === 1 ? "source" : "sources",
    notDone: "0 changed",
  };
}

/** The run card while an answer is in progress (UI spec "Run card"). */
function RunCard({
  turn: t,
  onStop,
  onOpen,
}: {
  turn: Turn;
  onStop: () => void;
  onOpen: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  const secs = Math.round((now - t.startedAt) / 1000);
  const line =
    t.phase === "searching"
      ? t.passages
        ? `Read ${t.passages} passages from ${t.documents} source${t.documents === 1 ? "" : "s"}; drafting`
        : "Searching your sources"
      : `Checking each statement against its source (${t.checked} of ${t.drafts.length})`;
  return (
    <div className="rk-msg rk-msg--rocky">
      <Pebble size={24} state={t.phase === "searching" ? "thinking" : "working"} />
      <div className="rk-run-card">
        <div className="rk-run-card__head">
          <StatusChip state={t.phase === "searching" ? "thinking" : "working"} />
          <span className="rk-small rk-muted">{secs}s</span>
        </div>
        <p className="rk-run-card__line" aria-live="polite">
          {line}
          {secs >= 8 && t.phase === "searching" ? " · Taking longer than usual" : ""}
        </p>
        {t.drafts.length > 0 && (
          <p className="rk-msg__draft">
            <SafeText text={t.drafts.join(" ")} />
          </p>
        )}
        <div className="rk-msg__inline-actions">
          <Button dense variant="primary" icon={<Square size={14} aria-hidden />} onClick={onStop}>
            Stop
          </Button>
          <Button dense variant="tertiary" onClick={onOpen}>
            Open
          </Button>
        </div>
      </div>
    </div>
  );
}

function Verification({ result }: { result: AskResult }) {
  if (result.notFound)
    return (
      <p className="rk-verify rk-verify--none">
        <CircleSlash size={16} strokeWidth={1.5} aria-hidden /> Checked: no source answers this
      </p>
    );
  const weak = result.answer.filter((s) => s.status !== "supported").length;
  return (
    <p className={`rk-verify ${weak ? "rk-verify--weak" : "rk-verify--ok"}`}>
      {weak
        ? `${weak} statement${weak > 1 ? "s" : ""} only partly supported`
        : "Every statement checked against its source"}
      {result.path?.local && " · checked locally"}
    </p>
  );
}

function ModelLine({ result }: { result: AskResult }) {
  const p = result.path;
  if (!p) return null;
  return (
    <span className="rk-small rk-muted">
      {p.local ? "On this computer" : "Online"} · {p.model}
      {p.fallbackReason && ` (fallback: ${p.fallbackReason.replace(/_/g, " ")})`}
      {!p.local && ` · $${result.usage.costUsd.toFixed(4)}`}
    </span>
  );
}

function HistorySkeleton() {
  return (
    <div className="rk-chat__turns" role="status" aria-label="Loading the conversation">
      {[0, 1].map((i) => (
        <div key={i} className="rk-turn" aria-hidden="true">
          <span className="rk-skeleton rk-skel-bubble rk-skel-bubble--user" />
          <span className="rk-skeleton rk-skel-bubble" />
        </div>
      ))}
    </div>
  );
}

// --- Empty state ---

function EmptyChat({
  heading,
  grounding,
  onPick,
}: {
  heading: string;
  grounding: string;
  onPick: (q: string) => void;
}) {
  const mine = useQuery({ queryKey: ["suggestions"], queryFn: onboarding.suggestions });
  const sample = useQuery({ queryKey: ["sample"], queryFn: onboarding.sample });
  const setup = useQuery({ queryKey: ["onboarding"], queryFn: onboarding.get });
  const starters = [
    ...(mine.data?.questions ?? []),
    ...(sample.data?.loaded ? sample.data.tour.map((t) => t.question) : []),
  ].slice(0, 3);
  return (
    <div className="rk-chat__empty">
      <h1 className="rk-title">{heading}</h1>
      <p className="rk-muted">{grounding}</p>
      {starters.length > 0 && (
        <ul className="rk-chat__starters" aria-label="Starter questions">
          {starters.map((q) => (
            <li key={q}>
              <button type="button" className="rk-starter-chip" onClick={() => onPick(q)}>
                {q}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="rk-small rk-muted">
        {setup.data?.preset === "read-only"
          ? "Read only is on: Rocky reads and answers, and proposes no changes."
          : "Rocky asks before any change; answering never changes anything."}
      </p>
    </div>
  );
}

// --- Composer ---

function Composer({
  text,
  setText,
  busy,
  inputRef,
  onSubmit,
  onKeyDown,
  onStop,
  showFlagged,
  setShowFlagged,
  notebookIds,
  route,
  setRoute,
}: {
  route: Route;
  /** Absent when the cloud is out of reach (no key, or local-only): no switch is shown. */
  setRoute: ((r: Route) => void) | undefined;
  text: string;
  setText: (s: string) => void;
  busy: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: (e?: FormEvent) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onStop: () => void;
  showFlagged: boolean;
  setShowFlagged: (v: boolean) => void;
  notebookIds: string[] | undefined;
}) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const setup = useQuery({ queryKey: ["onboarding"], queryFn: onboarding.get });
  const notebooks = useQuery({ queryKey: ["notebooks"], queryFn: api.notebooks });
  const scope = notebookIds?.length
    ? (notebooks.data?.notebooks
        .filter((n) => notebookIds.includes(n.id))
        .map((n) => n.name)
        .join(", ") ?? "This notebook")
    : "Everything";
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 24 * 10 + 16)}px`;
  };
  return (
    <form className="rk-composer" onSubmit={onSubmit}>
      <label htmlFor="composer" className="sr-only">
        Ask about your work
      </label>
      <textarea
        id="composer"
        ref={inputRef}
        rows={2}
        value={text}
        placeholder="Ask about your work…"
        onChange={(e) => {
          setText(e.target.value);
          grow(e.target);
        }}
        onKeyDown={onKeyDown}
        className="rk-composer__input"
      />
      <div className="rk-composer__bar">
        <div className="rk-composer__chips">
          <span className="rk-chip-quiet" title="Where Rocky looks">
            <BookOpen size={14} strokeWidth={1.5} aria-hidden /> {scope}
          </span>
          <Link to="/settings" className="rk-chip-quiet" title="Change in Settings">
            {setup.data?.preset === "read-only" ? "Read only" : "Ask about everything"}
          </Link>
          {setRoute ? (
            // Per question (D-068): Cloud shows the passages it would send before anything goes.
            <Segmented
              label="Where this question is answered"
              value={route}
              onChange={setRoute}
              options={[
                { value: "local", label: "On this computer" },
                { value: "cloud", label: "Cloud" },
              ]}
            />
          ) : (
            settings.data && (
              <span className="rk-chip-quiet">
                {settings.data.localOnly ? "Local models only" : "On this computer"}
              </span>
            )
          )}
          <Switch label="Show flagged" checked={showFlagged} onChange={setShowFlagged} />
        </div>
        {busy ? (
          <Button variant="primary" icon={<Square size={14} aria-hidden />} onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button
            variant="primary"
            type="submit"
            disabled={!text.trim()}
            icon={<ArrowUp size={16} aria-hidden />}
          >
            Send
          </Button>
        )}
      </div>
      <p className="rk-composer__hint rk-small rk-muted">
        Enter to send · Shift+Enter for a new line · ↑ edits the last question · Ctrl+. stops
      </p>
    </form>
  );
}

// --- Work pane ---

function ActivityPanel({ turn: t }: { turn: Turn | undefined }) {
  if (!t) return <p className="rk-small rk-muted">Each question's steps show here.</p>;
  const r = t.result;
  const steps: { done: boolean; text: string }[] = [
    {
      done: t.phase !== "searching" || t.passages > 0,
      text: r
        ? `Searched your sources · ${sourcesOf(r)} source${sourcesOf(r) === 1 ? "" : "s"} used`
        : t.passages
          ? `Searched your sources · ${t.passages} passages from ${t.documents} sources`
          : "Search your sources",
    },
    {
      done: t.phase === "checking" || t.phase === "done",
      text: r
        ? `Drafted ${r.answer.length} statement${r.answer.length === 1 ? "" : "s"}`
        : t.drafts.length
          ? `Drafting · ${t.drafts.length} so far`
          : "Draft an answer",
    },
    {
      done: t.phase === "done",
      text: r
        ? r.notFound
          ? "Checked: nothing in your sources answers it"
          : `Checked every statement · ${r.answer.filter((s) => s.status === "supported").length} supported`
        : `Check each statement against its source${t.checked ? ` · ${t.checked} done` : ""}`,
    },
  ];
  return (
    <div className="rk-pane__body">
      <p className="rk-small">
        <strong>{t.question}</strong>
      </p>
      <ol className="rk-steps">
        {steps.map((s) => (
          <li key={s.text} data-planned={!s.done || undefined}>
            {s.text}
          </li>
        ))}
      </ol>
      {t.phase === "failed" && t.error && (
        <Banner tone={t.error.code === "STOPPED" ? "info" : "error"} title={t.error.message} />
      )}
      <p className="rk-small rk-muted">
        Every question is also in the <Link to="/ledger">ledger</Link>.
      </p>
    </div>
  );
}

function SourcesPanel({ turns, onOpen }: { turns: Turn[]; onOpen: (c: Citation) => void }) {
  const byDoc = new Map<string, { citation: Citation; uses: number }>();
  for (const t of turns)
    for (const s of t.result?.answer ?? [])
      for (const c of s.citations) {
        const seen = byDoc.get(c.documentId);
        byDoc.set(c.documentId, { citation: seen?.citation ?? c, uses: (seen?.uses ?? 0) + 1 });
      }
  if (!byDoc.size)
    return <p className="rk-small rk-muted">Sources Rocky cites in this conversation show here.</p>;
  return (
    <ul className="rk-pane__list">
      {[...byDoc.values()].map(({ citation, uses }) => (
        <li key={citation.documentId}>
          <button type="button" className="rk-row-open" onClick={() => onOpen(citation)}>
            <span>{citation.title}</span>
            <span className="rk-small rk-muted">
              cited {uses} time{uses === 1 ? "" : "s"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function MemoryPanel() {
  return (
    <div className="rk-pane__body">
      <p className="rk-small">
        Answers don't use your memory profile yet; they come only from your sources. When they do,
        each line used will show here.
      </p>
      <Link to="/memory" className="rk-small">
        Open Memory
      </Link>
    </div>
  );
}

// --- History ---

function HistoryDrawer({
  open,
  onClose,
  currentId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  currentId: string | undefined;
  onPick: (id: string) => void;
}) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["conversations"],
    queryFn: conversations.list,
    enabled: open,
  });
  const remove = useMutation({
    mutationFn: conversations.remove,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
  return (
    <Drawer open={open} onClose={onClose} title="Past conversations">
      {list.isLoading && <Skeleton rows={4} height={52} label="Loading conversations" />}
      {list.data?.conversations.length === 0 && (
        <p className="rk-small rk-muted">Conversations are saved after their first answer.</p>
      )}
      <ul className="rk-pane__list">
        {list.data?.conversations.map((c) => (
          <li key={c.id} className="rk-history-row">
            <button
              type="button"
              className="rk-row-open"
              aria-current={c.id === currentId || undefined}
              onClick={() => onPick(c.id)}
            >
              <span>{c.title || "Untitled"}</span>
              <span className="rk-small rk-muted">
                {new Date(c.updatedAt).toLocaleDateString()} · {c.turns} question
                {c.turns === 1 ? "" : "s"}
              </span>
            </button>
            <IconButton label={`Delete "${c.title}"`} dense onClick={() => remove.mutate(c.id)}>
              <Trash2 size={16} strokeWidth={1.5} aria-hidden />
            </IconButton>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

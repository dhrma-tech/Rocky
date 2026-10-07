import type { Brief, Citation, Commitment, TimelineItem } from "@rocky/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlarmClock,
  ArrowUp,
  CalendarDays,
  CircleAlert,
  ListChecks,
  Loader,
  NotebookPen,
  Sparkles,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { assistant } from "../api.ts";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { Badge, Button, cls, IconButton } from "../components/ui.tsx";
import { PathLine, Sentences } from "../components/verified.tsx";

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const date = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** DESIGN screen 1: composer, then brief cards (today, due soon, overdue, approvals) and the last routine. */
export function HomePage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Citation | null>(null);
  const [brief, setBrief] = useState<TimelineItem | null>(null);
  const home = useQuery({ queryKey: ["home"], queryFn: assistant.home, refetchInterval: 60_000 });
  const ask = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) void navigate({ to: "/ask", search: { q: q.trim() } });
  };
  const h = home.data;

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[960px] flex-col gap-8 px-4 py-16 sm:px-8">
          <form onSubmit={ask} className="mx-auto w-full max-w-[720px]">
            <h1 className="text-2xl font-normal leading-8">What do you want to know?</h1>
            <div className="mt-4 flex items-end gap-2 rounded-lg bg-raised p-3 shadow-raised-md focus-within:shadow-[var(--composer-glow)]">
              <label htmlFor="home-q" className="sr-only">
                Ask your sources
              </label>
              <textarea
                id="home-q"
                value={q}
                rows={2}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) ask(e);
                }}
                placeholder="Ask anything in your meetings, mail, docs and notebooks"
                className="min-h-12 flex-1 resize-none bg-transparent p-1 text-base outline-none"
              />
              <button
                type="submit"
                aria-label="Ask"
                disabled={!q.trim()}
                className="group inline-flex size-11 items-center justify-center"
              >
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-accent text-on-accent group-hover:bg-accent-hover group-disabled:bg-layer-subtle group-disabled:text-tertiary">
                  <ArrowUp size={16} aria-hidden />
                </span>
              </button>
            </div>
          </form>

          {home.error && (
            <p role="alert" className="text-sm text-danger">
              {home.error.message}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card icon={CalendarDays} title="Today" count={h?.today.length}>
              {h && h.today.length === 0 && <Empty>Nothing on the calendar today.</Empty>}
              <ul className="flex flex-col gap-1">
                {h?.today.map((i) => (
                  <li
                    key={`${i.source}-${i.title}-${i.start}`}
                    className="flex items-center gap-2 text-sm"
                  >
                    <span className="tabular w-12 shrink-0 text-xs text-secondary">
                      {i.allDay ? "all day" : time(i.start)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{i.title}</span>
                    {i.kind === "event" && i.documentId && (
                      <Button
                        variant="ghost"
                        className="min-h-9 px-2 text-xs"
                        onClick={() => setBrief(i)}
                      >
                        <Sparkles size={14} aria-hidden /> Brief me
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
            <Card icon={ListChecks} title="Needs your approval" count={h?.pendingApprovals}>
              {h && (
                <p className="text-sm text-secondary">
                  {h.pendingApprovals === 0 ? (
                    "Nothing is waiting. Drafts and proposals land here first."
                  ) : (
                    <Link to="/actions">
                      Review {h.pendingApprovals} proposal{h.pendingApprovals === 1 ? "" : "s"}
                    </Link>
                  )}
                </p>
              )}
            </Card>
            <Card icon={AlarmClock} title="Due this week" count={h?.dueSoon.length}>
              <CommitmentList items={h?.dueSoon} empty="Nothing due in the next 7 days." />
            </Card>
            <Card
              icon={CircleAlert}
              title="Overdue"
              count={h?.overdue.length}
              tone={h?.overdue.length ? "danger" : undefined}
            >
              <CommitmentList items={h?.overdue} empty="Nothing overdue." overdue />
            </Card>
          </div>

          <section aria-labelledby="last-run" className="rounded-lg bg-raised p-6 shadow-raised-sm">
            <div className="flex flex-wrap items-center gap-2">
              <NotebookPen size={18} aria-hidden className="text-accent-strong" />
              <h2 id="last-run" className="mr-auto text-sm font-semibold">
                {h?.lastRun
                  ? `${h.lastRun.name}, ${date(h.lastRun.run.startedAt)} ${time(h.lastRun.run.startedAt)}`
                  : "Routines"}
              </h2>
              <Link to="/routines" className="text-sm">
                Routines
              </Link>
            </div>
            {h?.lastRun ? (
              <div className="mt-3 space-y-2">
                {h.lastRun.run.notFound ? (
                  <p className="text-sm text-secondary">Nothing to report from your sources.</p>
                ) : (
                  <Sentences answer={h.lastRun.run.answer} onOpen={setOpen} />
                )}
                <PathLine path={h.lastRun.run.path} />
              </div>
            ) : (
              <p className="mt-2 text-sm text-secondary">
                Turn on the morning brief in Routines to get a cited summary of your day here.
              </p>
            )}
          </section>
        </div>
      </div>
      {brief && <BriefPanel item={brief} onClose={() => setBrief(null)} onOpen={setOpen} />}
      {open && (
        <div className="fixed inset-0 z-40 lg:relative lg:z-20">
          <SourceViewer citation={open} onClose={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}

function Card({
  icon: Icon,
  title,
  count,
  tone,
  children,
}: {
  icon: typeof CalendarDays;
  title: string;
  count: number | undefined;
  tone?: "danger" | undefined;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="relative overflow-hidden rounded-lg bg-raised p-4 shadow-raised-sm before:pointer-events-none before:absolute before:inset-0 before:bg-[image:var(--card-glow)] before:opacity-70"
    >
      <div className="relative mb-2 flex items-center gap-2">
        <Icon
          size={18}
          aria-hidden
          className={tone === "danger" ? "text-danger" : "text-accent-strong"}
        />
        <h2 className="mr-auto text-sm font-semibold">{title}</h2>
        {count !== undefined && count > 0 && (
          <Badge tone={tone === "danger" ? "danger" : "accent"}>
            <span className="tabular">{count}</span>
          </Badge>
        )}
      </div>
      <div className="relative">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-secondary">{children}</p>
);

function CommitmentList({
  items,
  empty,
  overdue,
}: {
  items: Commitment[] | undefined;
  empty: string;
  overdue?: boolean;
}) {
  if (!items) return null;
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="flex flex-col gap-1">
      {items.slice(0, 5).map((c) => (
        <li key={c.id} className="flex items-center gap-2 text-sm">
          <span
            className={cls(
              "tabular w-16 shrink-0 text-xs",
              overdue ? "text-danger" : "text-secondary",
            )}
          >
            {c.deadline ? date(c.deadline) : ""}
          </span>
          <span className="min-w-0 flex-1 truncate">{c.text}</span>
        </li>
      ))}
      {items.length > 5 && (
        <li className="text-xs">
          <Link to="/commitments">{items.length - 5} more</Link>
        </li>
      )}
    </ul>
  );
}

/** Meeting brief (POST /briefs, SSE): computed facts first, then verified, cited sentences. */
function BriefPanel({
  item,
  onClose,
  onOpen,
}: {
  item: TimelineItem;
  onClose: () => void;
  onOpen: (c: Citation) => void;
}) {
  const [status, setStatus] = useState("Collecting context");
  const run = useMutation({
    mutationFn: () =>
      assistant.brief({ eventId: item.documentId as string }, (e) => {
        if (e.type === "draft_sentence") setStatus("Writing");
        if (e.type === "verified") setStatus("Checking each sentence against its source");
      }),
  });
  const cached = useQuery({
    queryKey: ["brief", item.documentId],
    queryFn: () => assistant.latestBrief("event", item.documentId as string),
  });
  const b: Brief | null | undefined = run.data ?? cached.data?.brief;

  return (
    <aside
      aria-label={`Brief: ${item.title}`}
      className="fixed inset-0 z-30 flex flex-col border-l border-border-base bg-raised lg:relative lg:w-[420px]"
    >
      <header className="flex items-start gap-2 border-b border-border-base p-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{item.title}</h2>
          <p className="text-xs text-secondary">{item.allDay ? "All day" : time(item.start)}</p>
        </div>
        <IconButton label="Close brief" onClick={onClose}>
          <X size={20} aria-hidden />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <Button
          variant={b ? "secondary" : "primary"}
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? (
            <Loader size={16} aria-hidden className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Sparkles size={16} aria-hidden />
          )}
          {b ? "Brief again" : "Write the brief"}
        </Button>
        {run.isPending && (
          <p aria-live="polite" className="text-sm text-secondary">
            {status}…
          </p>
        )}
        {run.error && (
          <p role="alert" className="text-sm text-danger">
            {run.error.message}
          </p>
        )}
        {b && (
          <>
            {b.facts.length > 0 && (
              <ul aria-label="Dates" className="space-y-1 text-sm">
                {b.facts.map((f) => (
                  <li key={`${f.label}-${f.detail}`}>
                    <span className="font-medium">{f.label}</span>
                    {f.at ? ` ${date(f.at)}` : ""}: {f.detail}
                  </li>
                ))}
              </ul>
            )}
            {b.notFound ? (
              <p className="text-sm text-secondary">
                Nothing in your sources about this meeting yet.
              </p>
            ) : (
              <Sentences answer={b.answer} onOpen={onOpen} />
            )}
            <PathLine path={b.path} />
            <p className="text-xs text-tertiary">
              Written {date(b.createdAt)} {time(b.createdAt)}
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

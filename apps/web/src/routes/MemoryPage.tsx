import type { ActionRecord } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api, type MemoryFileView, memory } from "../api.ts";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from "../ui/index.tsx";
import "./screens.css";

const GROUPS = ["About you", "Preferences", "People", "Projects"] as const;
const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Memory (UI spec 13, roadmap A5): read, edit and forget everything Rocky remembers. New learnings
 * first (they wait for approval), then the files, then where each fact came from. The files live
 * on disk; the page says where.
 */
export function MemoryPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["memory"], queryFn: memory.list });
  const pending = useQuery({ queryKey: ["actions", "draft"], queryFn: () => api.actions("draft") });
  const learned = (pending.data?.actions ?? []).filter((a) => a.type === "memory.add");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["memory"] });
    void qc.invalidateQueries({ queryKey: ["actions"] });
  };

  const files = list.data?.files ?? [];
  const q = query.trim().toLowerCase();
  const shown = files.filter(
    (f) =>
      !q ||
      f.title.toLowerCase().includes(q) ||
      f.facts.some((x) => x.text.toLowerCase().includes(q)),
  );
  const selected = files.find((f) => f.path === open) ?? null;

  if (list.isLoading)
    return (
      <div className="rk-page rk-page--wide">
        <h1 className="rk-title">Memory</h1>
        <div className="rk-split" style={{ marginTop: "var(--space-6)" }}>
          <Skeleton rows={6} height={44} label="Loading memory" />
          <Skeleton rows={1} height={360} label="Loading the editor" />
        </div>
      </div>
    );
  if (list.error)
    return (
      <div className="rk-page">
        <h1 className="rk-title">Memory</h1>
        <ErrorState
          title="Couldn't read your memory files."
          happened={list.error.message}
          rockyDid="Nothing was changed."
          fix={
            <Button variant="primary" onClick={refresh}>
              Retry
            </Button>
          }
        />
      </div>
    );

  return (
    <div className="rk-page rk-page--wide">
      <header className="rk-page__head">
        <h1 className="rk-title">Memory</h1>
        <span className="rk-small rk-muted" style={{ overflowWrap: "anywhere" }}>
          Plain Markdown files in <code className="rk-mono">{list.data?.dir}</code>. Export them
          with <code className="rk-mono">rocky memory export</code>.
        </span>
      </header>

      {learned.length > 0 && <LearnedBanner items={learned} onDone={refresh} />}

      {files.length === 0 && learned.length === 0 ? (
        <>
          <EmptyState
            headline="Nothing remembered yet."
            action={
              <Link to="/help" className="rk-button rk-button--secondary">
                Learn how Rocky asks first
              </Link>
            }
          >
            Rocky hasn't learned anything yet. It will ask before it saves anything. You can add a
            fact yourself below.
          </EmptyState>
          <AddFact files={files} onAdded={refresh} />
        </>
      ) : (
        <div className="rk-split">
          <section aria-label="Memory files" className={selected ? "rk-hide-narrow" : undefined}>
            <Input label="Search memory" value={query} onChange={(e) => setQuery(e.target.value)} />
            {GROUPS.map((g) => {
              const inGroup = shown.filter((f) => f.group === g);
              if (!inGroup.length) return null;
              return (
                <div key={g} style={{ marginTop: "var(--space-4)" }}>
                  <h2 className="rk-side__group" style={{ margin: "0 0 var(--space-1)" }}>
                    {g}
                  </h2>
                  <ul className="rk-queue">
                    {inGroup.map((f) => (
                      <li key={f.path}>
                        <button
                          type="button"
                          className="rk-queue__row"
                          aria-current={f.path === open ? "true" : undefined}
                          onClick={() => setOpen(f.path)}
                        >
                          <span className="rk-queue__sentence">{f.title}</span>
                          <span className="rk-small rk-muted">
                            {f.facts.length} fact{f.facts.length === 1 ? "" : "s"} ·{" "}
                            {day(f.updatedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {shown.length === 0 && <p className="rk-muted">No memory matches "{query}".</p>}
            <AddFact files={files} onAdded={refresh} />
          </section>
          <section aria-label="Selected memory">
            {selected ? (
              <MemoryEditor
                key={selected.path}
                file={selected}
                onBack={() => setOpen(null)}
                onChanged={refresh}
                toast={toast}
              />
            ) : (
              <Card>
                <p className="rk-muted" style={{ margin: 0 }}>
                  Select a file to read it, see where each fact came from, and edit or forget it.
                </p>
              </Card>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** New learnings wait for approval: Accept saves, Forget denies, Edit changes the wording first. */
function LearnedBanner({ items, onDone }: { items: ActionRecord[]; onDone: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSettled: onDone });
  const accept = (a: ActionRecord) =>
    act.mutate(async () => {
      const ok = await api.approveAction(a.id, a.payloadHash, a.review === "strict", 0);
      await api.executeAction(ok.id);
    });
  return (
    <Card tint style={{ marginBottom: "var(--space-6)" }}>
      <h2 className="rk-h2">Learned this week</h2>
      <p className="rk-small rk-muted">
        Rocky saves these only if you accept, and only while the quote is still in the source.
      </p>
      <ul className="rk-list" style={{ gap: "var(--space-3)" }}>
        {items.map((a) => {
          const p = a.payload as { fact: string; file: string; quote: string };
          return (
            <li key={a.id} style={{ display: "grid", gap: "var(--space-1)" }}>
              {editing === a.id ? (
                <Input label="Fact" value={text} onChange={(e) => setText(e.target.value)} />
              ) : (
                <strong>{p.fact}</strong>
              )}
              <span className="rk-small rk-muted">
                “{p.quote}” · {a.citations[0]?.title} · saved in {p.file}
              </span>
              <span className="rk-approval__actions">
                {editing === a.id ? (
                  <Button
                    variant="primary"
                    onClick={() =>
                      act.mutate(async () => {
                        const edited = await api.editAction(a.id, { ...p, fact: text });
                        setEditing(null);
                        await api.approveAction(
                          edited.id,
                          edited.payloadHash,
                          edited.review === "strict",
                          0,
                        );
                        await api.executeAction(edited.id);
                      })
                    }
                  >
                    Save and accept
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => accept(a)}>
                    Accept
                  </Button>
                )}
                <Button
                  onClick={() => {
                    setEditing(a.id);
                    setText(p.fact);
                  }}
                >
                  Edit
                </Button>
                <Button variant="tertiary" onClick={() => act.mutate(() => api.rejectAction(a.id))}>
                  Forget
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function AddFact({ files, onAdded }: { files: MemoryFileView[]; onAdded: () => void }) {
  const [fact, setFact] = useState("");
  const [where, setWhere] = useState("preferences.md");
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => {
    const base = [
      { value: "about-you.md", label: "About you" },
      { value: "preferences.md", label: "Preferences" },
    ];
    for (const f of files)
      if (!base.some((b) => b.value === f.path)) base.push({ value: f.path, label: f.title });
    return base;
  }, [files]);
  const add = useMutation({
    mutationFn: () => memory.fact(where, fact),
    onSuccess: () => {
      setFact("");
      setError(null);
      onAdded();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  return (
    <form
      className="rk-card"
      style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-6)" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (fact.trim().length >= 3) add.mutate();
      }}
    >
      <h2 className="rk-h3">Tell Rocky something</h2>
      <Input
        label="Fact"
        help="Saved as stated by you."
        value={fact}
        error={error}
        onChange={(e) => setFact(e.target.value)}
      />
      <Select label="Save in" value={where} onChange={setWhere} options={options} />
      <div>
        <Button
          type="submit"
          loading={add.isPending ? "Saving…" : false}
          disabled={fact.trim().length < 3}
        >
          Remember this
        </Button>
      </div>
    </form>
  );
}

function MemoryEditor({
  file,
  onBack,
  onChanged,
  toast,
}: {
  file: MemoryFileView;
  onBack: () => void;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const content = useQuery({
    queryKey: ["memory-file", file.path],
    queryFn: () => memory.file(file.path),
  });
  const [text, setText] = useState("");
  const [base, setBase] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  useEffect(() => {
    if (content.data) {
      setText(content.data.content);
      setBase(content.data.hash);
    }
  }, [content.data]);

  const save = useMutation({
    mutationFn: (args: { body: string; hash: string }) =>
      memory.save(file.path, args.body, args.hash),
    onSuccess: () => {
      setConflict(null);
      void content.refetch();
      onChanged();
      toast({ text: "Saved. The previous version is in the file's history." });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "CONFLICT") setConflict(String(e.body.current ?? ""));
    },
  });
  const forget = useMutation({
    mutationFn: async (index: number) => {
      const before = await memory.file(file.path);
      await memory.forget(file.path, index);
      return before.content;
    },
    onSuccess: (before) => {
      void content.refetch();
      onChanged();
      toast({
        text: "Forgotten.",
        action: {
          label: "Undo",
          run: () =>
            void memory
              .file(file.path)
              .then((now) => save.mutate({ body: before, hash: now.hash })),
        },
      });
    },
  });

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span className="rk-show-narrow">
          <IconButton label="Back to the list" onClick={onBack}>
            <ArrowLeft size={20} strokeWidth={1.5} aria-hidden />
          </IconButton>
        </span>
        <h2 className="rk-h2" style={{ flex: 1 }}>
          {file.title}
        </h2>
        <span className="rk-small rk-muted">memory/{file.path}</span>
      </div>

      <Card>
        <h3 className="rk-h3">Facts and where they came from</h3>
        {file.facts.length === 0 && <p className="rk-muted">No facts in this file yet.</p>}
        <ul className="rk-list" style={{ gap: "var(--space-3)" }}>
          {file.facts.map((f, i) => (
            <li
              key={`${f.text}-${f.provenance?.at ?? "none"}`}
              style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                {f.text}
                <span className="rk-small rk-muted" style={{ display: "block" }}>
                  {f.provenance?.by === "source"
                    ? `From “${f.provenance.title}”, ${day(f.provenance.at)}: “${f.provenance.quote}”`
                    : f.provenance?.by === "user"
                      ? `Stated by you, ${day(f.provenance.at)}`
                      : "No source recorded"}
                </span>
              </span>
              <Button dense variant="tertiary" onClick={() => forget.mutate(i)}>
                Forget
              </Button>
            </li>
          ))}
        </ul>
        <p className="rk-small rk-muted" style={{ margin: "var(--space-3) 0 0" }}>
          Used in: not tracked yet. Answers don't read memory until a later release.
        </p>
      </Card>

      {conflict !== null && (
        <Banner
          tone="warning"
          title="This file changed."
          actions={
            <>
              <Button
                variant="primary"
                onClick={() =>
                  void memory
                    .file(file.path)
                    .then((now) => save.mutate({ body: text, hash: now.hash }))
                }
              >
                Keep mine
              </Button>
              <Button
                onClick={() => {
                  setText(conflict);
                  setConflict(null);
                  void content.refetch();
                }}
              >
                Take theirs
              </Button>
              <Button
                variant="tertiary"
                onClick={() => {
                  const theirs = conflict.split("\n");
                  const merged = [
                    ...theirs,
                    ...text.split("\n").filter((l) => l.trim() && !theirs.includes(l)),
                  ].join("\n");
                  void memory
                    .file(file.path)
                    .then((now) => save.mutate({ body: merged, hash: now.hash }));
                }}
              >
                Merge
              </Button>
            </>
          }
        >
          <div className="rk-split" style={{ marginTop: "var(--space-2)" }}>
            <div>
              <strong className="rk-small">Yours</strong>
              <pre className="rk-mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                {text}
              </pre>
            </div>
            <div>
              <strong className="rk-small">On disk now</strong>
              <pre className="rk-mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                {conflict}
              </pre>
            </div>
          </div>
        </Banner>
      )}

      {content.isLoading ? (
        <Skeleton rows={1} height={240} label="Loading the file" />
      ) : (
        <form
          style={{ display: "grid", gap: "var(--space-3)" }}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ body: text, hash: base });
          }}
        >
          <Textarea
            label="Edit the file"
            className="rk-input rk-mono"
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div>
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending ? "Saving…" : false}
              disabled={text === content.data?.content}
            >
              Save
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

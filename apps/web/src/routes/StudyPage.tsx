import type { Citation, Rating } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CircleCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { api } from "../api.ts";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { CountdownCard, Flashcard } from "../components/study.tsx";
import { linkButton } from "../components/ui.tsx";

/** DESIGN screen 4: centered card flow. Review queue for all notebooks or one (`?notebook=`). */
export function StudyPage() {
  const { notebook } = useSearch({ from: "/study" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Citation | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const notebooks = useQuery({ queryKey: ["notebooks"], queryFn: api.notebooks });
  const queue = useQuery({
    queryKey: ["review", notebook ?? "all"],
    queryFn: () => api.reviewQueue(notebook),
  });
  const countdown = useQuery({
    queryKey: ["countdown", notebook],
    queryFn: () => api.countdown(notebook as string),
    enabled: Boolean(notebook),
  });
  const card = queue.data?.cards[0];
  const rate = useMutation({
    mutationFn: ({ id, rating }: { id: string; rating: Rating }) => api.reviewCard(id, rating),
    onSuccess: () => {
      setReviewed((n) => n + 1);
      void qc.invalidateQueries({ queryKey: ["review"] });
      void qc.invalidateQueries({ queryKey: ["notebooks"] });
      void qc.invalidateQueries({ queryKey: ["notebook"] });
    },
  });
  const onRate = useCallback(
    (rating: Rating) => {
      if (card && !rate.isPending) rate.mutate({ id: card.id, rating });
    },
    [card, rate],
  );
  const name = (id: string) => notebooks.data?.notebooks.find((n) => n.id === id)?.name;

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-16 sm:px-8">
          <header className="flex flex-wrap items-center gap-3">
            <h1 className="mr-auto text-2xl font-normal leading-8">Study</h1>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-secondary">Notebook</span>
              <select
                value={notebook ?? ""}
                onChange={(e) => {
                  setReviewed(0);
                  void navigate({
                    to: "/study",
                    search: e.target.value ? { notebook: e.target.value } : {},
                  });
                }}
                className="min-h-11 rounded-md border border-border-strong bg-page px-2 text-sm"
              >
                <option value="">All notebooks</option>
                {notebooks.data?.notebooks.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </label>
          </header>

          {queue.data && (
            <p className="tabular text-sm text-secondary" aria-live="polite">
              {queue.data.dueToday} due today · {queue.data.newToday} of {queue.data.newLimit} new
              cards today
              {reviewed > 0 && ` · ${reviewed} reviewed this session`}
            </p>
          )}
          {notebook && countdown.data?.exam && <CountdownCard data={countdown.data} />}
          {queue.error && (
            <p role="alert" className="text-sm text-danger">
              {queue.error.message}
            </p>
          )}
          {rate.error && (
            <p role="alert" className="text-sm text-danger">
              {rate.error.message}
            </p>
          )}

          {card && (
            <>
              {!notebook && name(card.notebookId) && (
                <p className="text-center text-xs text-secondary">{name(card.notebookId)}</p>
              )}
              <Flashcard card={card} onRate={onRate} busy={rate.isPending} onOpen={setOpen} />
            </>
          )}
          {queue.data && !card && (
            <div className="flex flex-col items-center gap-3 rounded-lg bg-raised p-10 text-center shadow-raised-sm">
              <CircleCheck size={24} aria-hidden className="text-success" />
              <p className="text-sm text-secondary">
                {reviewed > 0 ? "Done for now. Nothing else is due." : "Nothing is due."} Quizzes
                and new cards live in each notebook's Study tab.
              </p>
              {notebook ? (
                <Link to="/notebooks/$id" params={{ id: notebook }} className={linkButton}>
                  Open {name(notebook) ?? "notebook"}
                </Link>
              ) : (
                <Link to="/notebooks" className={linkButton}>
                  Notebooks
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
      {open && (
        <div className="fixed inset-0 z-30 lg:relative lg:z-20">
          <SourceViewer citation={open} onClose={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}

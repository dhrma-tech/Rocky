import type { AskResult, Citation } from "@rocky/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitBranch } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../api.ts";
import { Button } from "./ui.tsx";

/**
 * "Create GitHub issue" from a verified answer (Phase 4 acceptance #4). The user edits the exact
 * payload; it becomes a draft in the approval queue with the answer's citations. Nothing is sent
 * to GitHub until it is approved on the Actions page.
 */
export function CreateIssueButton({ question, result }: { question: string; result: AskResult }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const github = useQuery({
    queryKey: ["connectors"],
    queryFn: api.connectors,
    select: (d) => d.connectors.find((c) => c.kind === "github" && c.enabled && !c.readOnly),
  });
  const repos = (github.data?.config.repos as string[] | undefined) ?? [];
  const citations = [
    ...new Map(result.answer.flatMap((s) => s.citations).map((c) => [c.chunkId, c])).values(),
  ];
  const answerText = result.answer.map((s) => s.text).join(" ");
  const sources = citations
    .map((c: Citation, i) => `${i + 1}. ${c.title}: "${c.quote}"`)
    .join("\n");
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [title, setTitle] = useState(question.slice(0, 120));
  const [body, setBody] = useState(`${answerText}\n\nSources:\n${sources}`);
  const propose = useMutation({
    mutationFn: () =>
      api.proposeAction("github.issueCreate", { repo: repo || repos[0], title, body }, citations),
  });

  if (!github.data || !repos.length || result.notFound || !citations.length) return null;
  return (
    <>
      <Button
        variant="ghost"
        className="min-h-9 text-xs"
        onClick={() => dialog.current?.showModal()}
      >
        <GitBranch size={14} aria-hidden /> Create GitHub issue
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="issue-title"
        onClose={() => propose.reset()}
        className="m-auto w-[min(560px,calc(100vw-32px))] rounded-xl bg-overlay p-6 text-primary shadow-raised-lg backdrop:bg-scrim"
      >
        <h2 id="issue-title" className="text-lg font-semibold">
          Create a GitHub issue
        </h2>
        {propose.isSuccess ? (
          <div className="mt-3 space-y-4 text-sm">
            <p role="status">
              Added to the approval queue. Nothing is created on GitHub until you approve it.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => dialog.current?.close()}>
                Close
              </Button>
              <Link
                to="/approvals"
                className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 text-sm font-semibold text-on-accent no-underline"
              >
                Review in Actions
              </Link>
            </div>
          </div>
        ) : (
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              propose.mutate();
            }}
          >
            <label className="block text-sm">
              <span className="font-medium">Repository</span>
              <select
                value={repo || repos[0]}
                onChange={(e) => setRepo(e.target.value)}
                className="mt-1 min-h-11 w-full rounded-md border border-border-strong bg-page px-3 text-sm"
              >
                {repos.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium">Title</span>
              <input
                value={title}
                maxLength={256}
                required
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1 min-h-11 w-full rounded-md border border-border-strong bg-page px-3 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium">Body</span>
              <textarea
                value={body}
                rows={8}
                onChange={(e) => setBody(e.target.value)}
                className="mt-1 w-full rounded-md border border-border-strong bg-page p-3 font-mono text-xs"
              />
            </label>
            <p className="text-xs text-tertiary">
              It cites the {citations.length} source(s) behind this answer and waits for your
              approval.
            </p>
            {propose.error && (
              <p role="alert" className="text-sm text-danger">
                {propose.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => dialog.current?.close()}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!title.trim() || propose.isPending}>
                Add to approval queue
              </Button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}

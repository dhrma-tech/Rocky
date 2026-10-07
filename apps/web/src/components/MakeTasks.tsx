import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ListPlus, Loader } from "lucide-react";
import { useState } from "react";
import { assistant } from "../api.ts";
import { Button } from "./ui.tsx";

/**
 * "Turn this meeting into tickets/tasks" (Phase 6): the user's words decide which kinds of
 * actions are allowed; each proposal cites the transcript and waits in Actions for approval.
 */
export function MakeTasks({ documentId }: { documentId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("Make GitHub issues for the action items");
  const run = useMutation({
    mutationFn: () => assistant.propose(documentId, instruction.trim()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["actions"] }),
  });
  if (!open)
    return (
      <Button onClick={() => setOpen(true)}>
        <ListPlus size={16} aria-hidden /> Make tasks
      </Button>
    );
  return (
    <div className="w-full space-y-2 rounded-lg bg-raised p-4 shadow-raised-sm">
      <label className="flex flex-col gap-1 text-sm font-medium">
        What should Rocky propose?
        <input
          value={instruction}
          maxLength={2000}
          onChange={(e) => setInstruction(e.target.value)}
          className="min-h-11 rounded-md border border-border-strong bg-page px-3 text-sm font-normal"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={instruction.trim().length < 3 || run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending && (
            <Loader size={16} aria-hidden className="animate-spin motion-reduce:animate-none" />
          )}
          Propose
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
        <span className="text-xs text-tertiary">Proposals wait for your approval; at most 10.</span>
      </div>
      {run.error && (
        <p role="alert" className="text-sm text-danger">
          {run.error.message}
        </p>
      )}
      {run.data && (
        <div aria-live="polite" className="text-sm">
          <p>
            {run.data.proposed.length === 0 ? (
              "No proposals came out of this meeting."
            ) : (
              <>
                {run.data.proposed.length} proposal{run.data.proposed.length === 1 ? "" : "s"}{" "}
                added. <Link to="/actions">Review them in Actions</Link>
              </>
            )}
          </p>
          {run.data.dropped.length > 0 && (
            <details className="mt-1 text-xs text-secondary">
              <summary className="cursor-pointer">{run.data.dropped.length} left out</summary>
              <ul className="mt-1 list-disc pl-5">
                {run.data.dropped.map((d, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a static list of reasons
                  <li key={i}>
                    {d.type}: {d.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

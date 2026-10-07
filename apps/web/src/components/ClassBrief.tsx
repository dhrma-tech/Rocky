import type { Citation } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader, Sparkles } from "lucide-react";
import { assistant } from "../api.ts";
import { Button } from "./ui.tsx";
import { PathLine, Sentences } from "./verified.tsx";

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Pre-class brief (assistant.md "Briefs"): last lecture and what is due, cited; dates computed. */
export function ClassBrief({
  notebookId,
  onOpen,
}: {
  notebookId: string;
  onOpen: (c: Citation) => void;
}) {
  const qc = useQueryClient();
  const latest = useQuery({
    queryKey: ["brief", "notebook", notebookId],
    queryFn: () => assistant.latestBrief("notebook", notebookId),
  });
  const run = useMutation({
    mutationFn: () => assistant.brief({ notebookId }),
    onSuccess: (b) => qc.setQueryData(["brief", "notebook", notebookId], { brief: b }),
  });
  const b = latest.data?.brief;
  return (
    <section aria-labelledby="class-brief" className="rounded-lg bg-raised p-6 shadow-raised-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="class-brief" className="mr-auto text-lg font-semibold">
          Before the next class
        </h2>
        <Button disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? (
            <Loader size={16} aria-hidden className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Sparkles size={16} aria-hidden />
          )}
          {b ? "Brief again" : "Brief me"}
        </Button>
      </div>
      {run.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {run.error.message}
        </p>
      )}
      {b ? (
        <div className="mt-3 space-y-3">
          {b.startsAt && <p className="text-xs text-secondary">Next class {when(b.startsAt)}</p>}
          {b.facts.length > 0 && (
            <ul className="space-y-1 text-sm">
              {b.facts.map((f) => (
                <li key={`${f.label}-${f.detail}`}>
                  <span className="font-medium">{f.label}</span>
                  {f.at
                    ? ` ${new Date(f.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
                    : ""}
                  : {f.detail}
                </li>
              ))}
            </ul>
          )}
          {b.notFound ? (
            <p className="text-sm text-secondary">
              No recent lecture in this notebook to summarize.
            </p>
          ) : (
            <Sentences answer={b.answer} onOpen={onOpen} />
          )}
          <PathLine path={b.path} />
        </div>
      ) : (
        <p className="mt-2 text-sm text-secondary">
          A cited recap of the last lecture and what is due, written before class.
        </p>
      )}
    </section>
  );
}

import type { Brief, Citation, TimelineItem } from "@rocky/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { assistant } from "../api.ts";
import { Banner, Button } from "../ui/index.tsx";
import { PathLine, Sentences } from "./verified.tsx";

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const date = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** A verified brief for a calendar item: every sentence cites its source, or "Nothing found". */
export function BriefBody({ item, onOpen }: { item: TimelineItem; onOpen: (c: Citation) => void }) {
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
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <p className="rk-small rk-muted" style={{ margin: 0 }}>
        {item.allDay ? "All day" : time(item.start)}
      </p>
      <div>
        <Button
          variant={b ? "secondary" : "primary"}
          loading={run.isPending ? `${status}…` : false}
          onClick={() => run.mutate()}
        >
          {b ? "Brief again" : "Write the brief"}
        </Button>
      </div>
      {run.error && (
        <Banner tone="error" title="Couldn't write the brief.">
          {run.error.message}
        </Banner>
      )}
      {b && (
        <>
          {b.facts.length > 0 && (
            <ul aria-label="Dates" style={{ margin: 0, paddingLeft: "var(--space-5)" }}>
              {b.facts.map((f) => (
                <li key={`${f.label}-${f.detail}`}>
                  <strong>{f.label}</strong>
                  {f.at ? ` ${date(f.at)}` : ""}: {f.detail}
                </li>
              ))}
            </ul>
          )}
          {b.notFound ? (
            <p className="rk-muted">Nothing in your sources about this meeting yet.</p>
          ) : (
            <Sentences answer={b.answer} onOpen={onOpen} />
          )}
          <PathLine path={b.path} />
          <p className="rk-small rk-muted" style={{ margin: 0 }}>
            Written {date(b.createdAt)} {time(b.createdAt)}
          </p>
        </>
      )}
    </div>
  );
}

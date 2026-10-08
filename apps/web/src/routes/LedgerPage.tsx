import type { RockyEvent } from "@rocky/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLive } from "../agent-ui/live.tsx";
import { ActivityRow, eventSentence } from "../agent-ui/work.tsx";
import { api } from "../api.ts";
import {
  Button,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
  Switch,
  useKeys,
  useToast,
} from "../ui/index.tsx";
import "./screens.css";

const KINDS: { kind: RockyEvent["kind"]; label: string }[] = [
  { kind: "approval", label: "Approvals" },
  { kind: "receipt", label: "Receipts" },
  { kind: "status", label: "Status" },
  { kind: "error", label: "Errors" },
  { kind: "memory", label: "Memory" },
  { kind: "message", label: "Messages" },
];

const download = (name: string, type: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * The ledger (UI spec 8): the ordered record of what Rocky did, planned and was blocked from doing.
 * Planned actions are drawn outlined until they happen. The newest 2000 events are kept in view;
 * the full history stays in the store (docs/DECISIONS.md D-036).
 */
export function LedgerPage() {
  const live = useLive();
  const toast = useToast();
  const [kinds, setKinds] = useState<Set<RockyEvent["kind"]>>(new Set());
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [open, setOpen] = useState<RockyEvent | null>(null);
  const [cursor, setCursor] = useState(-1);
  const list = useRef<HTMLUListElement>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return live.events.filter(
      (e) =>
        (kinds.size === 0 || kinds.has(e.kind)) &&
        (!q || eventSentence(e).toLowerCase().includes(q)),
    );
  }, [live.events, kinds, query]);

  // Follow live: stay at the newest event unless the user scrolled up to read.
  const count = shown.length;
  useEffect(() => {
    if (follow && count && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [count, follow]);
  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom && follow) setFollow(false);
  };

  useKeys((key, e) => {
    if (key !== "j" && key !== "k") return;
    e.preventDefault();
    setFollow(false);
    const next = Math.max(0, Math.min(shown.length - 1, cursor + (key === "j" ? 1 : -1)));
    setCursor(next);
    list.current?.querySelectorAll<HTMLButtonElement>(".rk-row-open")[next]?.focus();
  });

  const verify = useMutation({
    mutationFn: api.verifyAudit,
    onSuccess: (r) =>
      toast({
        text: r.ok
          ? `The audit chain checks out (${r.checked} entries).`
          : `The audit chain is broken at entry ${r.firstBrokenSeq}: ${r.reason}`,
      }),
  });

  const toggle = (k: RockyEvent["kind"]) =>
    setKinds((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className="rk-page">
      <header className="rk-page__head">
        <h1 className="rk-title">Ledger</h1>
        <Switch label="Follow live" checked={follow} onChange={setFollow} />
        <Button
          onClick={() =>
            download(
              `rocky-ledger-${Date.now()}.json`,
              "application/json",
              JSON.stringify(shown, null, 2),
            )
          }
        >
          Export JSON
        </Button>
        <Button
          onClick={() =>
            download(
              `rocky-ledger-${Date.now()}.md`,
              "text/markdown",
              shown
                .map((e) => `- ${new Date(e.at).toISOString()} · ${eventSentence(e)}`)
                .join("\n"),
            )
          }
        >
          Export Markdown
        </Button>
        <Button
          variant="tertiary"
          onClick={() => verify.mutate()}
          loading={verify.isPending ? "Checking…" : false}
        >
          Verify the audit chain
        </Button>
      </header>

      <div className="rk-filters" role="toolbar" aria-label="Filters">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            className="rk-filter"
            aria-pressed={kinds.has(k.kind)}
            onClick={() => toggle(k.kind)}
          >
            {k.label}
          </button>
        ))}
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <Input
            label="Search the ledger"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {live.loading && <Skeleton rows={8} height={44} label="Loading the ledger" />}

      {live.error && (
        <ErrorState
          title="Couldn't read the ledger."
          happened={live.error.message}
          rockyDid="Nothing was changed."
          fix={
            <Button variant="primary" onClick={() => location.reload()}>
              Retry
            </Button>
          }
        />
      )}

      {!live.loading && !live.error && live.events.length === 0 && (
        <EmptyState
          headline="No activity yet."
          action={
            <Link to="/" className="rk-button rk-button--secondary">
              Go to Today
            </Link>
          }
        >
          Anything Rocky does will show up here.
        </EmptyState>
      )}

      {!live.loading && !live.error && live.events.length > 0 && (
        <>
          <p className="rk-small rk-muted" style={{ marginTop: 0 }}>
            {shown.length} of the latest {live.events.length} events · J and K to move · Enter opens
            the payload
          </p>
          <ul
            ref={list}
            className="rk-ledger"
            onScroll={onScroll}
            aria-label="Events, oldest first"
          >
            {shown.map((e, i) => (
              <ActivityRow
                key={e.seq}
                event={e}
                {...(e.kind === "receipt" ? { worker: e.tool } : {})}
                actions={
                  <span style={{ display: "flex", gap: "var(--space-2)" }}>
                    {e.runId && (
                      <Link
                        to="/runs/$id"
                        params={{ id: e.runId }}
                        className="rk-row-open"
                        style={{ display: "inline-flex", alignItems: "center" }}
                      >
                        Run
                      </Link>
                    )}
                    <button
                      type="button"
                      className="rk-row-open"
                      onFocus={() => setCursor(i)}
                      onClick={() => setOpen(e)}
                    >
                      Payload
                    </button>
                  </span>
                }
              />
            ))}
          </ul>
        </>
      )}

      <Drawer open={open !== null} onClose={() => setOpen(null)} title="Event payload">
        {open && (
          <div className="rk-detail" style={{ display: "grid", gap: "var(--space-3)" }}>
            <p style={{ margin: 0 }}>{eventSentence(open)}</p>
            <pre className="rk-mono">{JSON.stringify(open, null, 2)}</pre>
          </div>
        )}
      </Drawer>
    </div>
  );
}

import type { DoctorCheck, DoctorReport } from "@rocky/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, Copy, ExternalLink, Keyboard, Stethoscope } from "lucide-react";
import { useState } from "react";
import { Chip } from "../agent-ui/StatusChip.tsx";
import { system } from "../api.ts";
import {
  ARTICLES,
  type Article,
  COMMON,
  HELP_CATEGORIES,
  searchArticles,
} from "../help/articles.ts";
import { openShortcuts } from "../help/shortcuts.tsx";
import { Button, Card, IconButton, Input, useToast } from "../ui/index.tsx";
import "./screens.css";

const ISSUES = "https://github.com/dhrma-tech/Rocky/issues/new";
const TONE: Record<DoctorCheck["status"], "success" | "warning" | "error"> = {
  pass: "success",
  warn: "warning",
  fail: "error",
};
const WORD: Record<DoctorCheck["status"], string> = { pass: "OK", warn: "Check", fail: "Problem" };

/** Debug info for a bug report: versions and check results. No keys, tokens or content. */
function debugInfo(version: string | undefined, report: DoctorReport | undefined): string {
  const lines = [
    `Rocky ${version ?? "unknown version"}`,
    `Browser: ${navigator.userAgent}`,
    ...(report
      ? [
          `OS: ${report.hardware.platform} ${report.hardware.release}, ${report.hardware.ramGb} GB RAM`,
          ...report.checks.map((c) => `${c.status.toUpperCase()} ${c.label}: ${c.detail}`),
        ]
      : ["Diagnostics: not run"]),
  ];
  // Paths can carry the user's name; keep the shape, drop the person.
  return lines.join("\n").replace(/([\\/](?:Users|home))[\\/][^\\/\s]+/gi, "$1/<user>");
}

/**
 * Help (UI spec 20): search first, the three most common problems, then categories. Articles ship
 * in the app (offline). Run diagnostics uses the engine's `rocky doctor` checks; Report an issue
 * opens GitHub with the info filled in, and nothing is sent unless you submit it there.
 */
export function HelpPage() {
  const { a } = useSearch({ strict: false }) as { a?: string };
  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const health = useQuery({ queryKey: ["health"], queryFn: system.health, retry: false });
  const diag = useMutation({ mutationFn: system.diagnostics });
  const open = ARTICLES.find((x) => x.id === a);
  const results = searchArticles(query);
  const info = () => debugInfo(health.data?.version, diag.data);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info());
      toast({ text: "Debug info copied. It has no keys, tokens or content." });
    } catch {
      toast({ text: "Couldn't copy. Your browser blocked the clipboard." });
    }
  };
  const issueUrl = `${ISSUES}?${new URLSearchParams({
    title: "",
    body: `What happened:\n\nWhat I expected:\n\n---\n${info()}`,
  })}`;

  const tools = (
    <section className="rk-help__tools" aria-label="Diagnostics">
      <Button
        icon={<Stethoscope size={16} strokeWidth={1.5} aria-hidden />}
        loading={diag.isPending && "Checking…"}
        onClick={() => diag.mutate()}
      >
        Run diagnostics
      </Button>
      <Button icon={<Copy size={16} strokeWidth={1.5} aria-hidden />} onClick={() => void copy()}>
        Copy debug info
      </Button>
      <a className="rk-button rk-button--tertiary" href={issueUrl} target="_blank" rel="noreferrer">
        <ExternalLink size={16} strokeWidth={1.5} aria-hidden /> Report an issue
      </a>
      <Button
        variant="tertiary"
        icon={<Keyboard size={16} strokeWidth={1.5} aria-hidden />}
        onClick={openShortcuts}
      >
        Shortcuts (?)
      </Button>
    </section>
  );

  if (open)
    return (
      <div className="rk-page">
        <header className="rk-page__head">
          <IconButton label="Back to Help" onClick={() => void navigate({ to: "/help" })}>
            <ArrowLeft size={20} strokeWidth={1.5} aria-hidden />
          </IconButton>
          <h1 className="rk-title">{open.title}</h1>
        </header>
        <p className="rk-small rk-muted">{open.category}</p>
        <article className="rk-help__article">
          {open.body.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </article>
        {open.link && (
          <Link to={open.link.to} className="rk-button rk-button--secondary">
            {open.link.label}
          </Link>
        )}
        <div style={{ marginTop: "var(--space-8)" }}>{tools}</div>
        <Diagnostics report={diag.data} error={diag.error} />
      </div>
    );

  return (
    <div className="rk-page rk-page--wide">
      <header className="rk-page__head">
        <h1 className="rk-title">Help</h1>
      </header>
      <Input
        label="Search help"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="What do you need?"
      />
      {tools}
      <Diagnostics report={diag.data} error={diag.error} />
      {query.trim() ? (
        <section className="rk-section" aria-label="Results" aria-live="polite">
          {results.length ? (
            <ArticleList items={results} />
          ) : (
            <p className="rk-muted">No results. Try fewer words or run diagnostics.</p>
          )}
        </section>
      ) : (
        <>
          <section className="rk-section" aria-labelledby="help-common">
            <h2 id="help-common" className="rk-h2">
              Common problems
            </h2>
            <ArticleList items={COMMON.flatMap((id) => ARTICLES.filter((x) => x.id === id))} />
          </section>
          <ul className="rk-routines" aria-label="Categories">
            {HELP_CATEGORIES.map((c) => (
              <Card as="li" key={c} className="rk-routine">
                <h2 className="rk-h3">{c}</h2>
                <ul className="rk-help__links">
                  {ARTICLES.filter((x) => x.category === c).map((x) => (
                    <li key={x.id}>
                      <Link to="/help" search={{ a: x.id }}>
                        {x.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ArticleList({ items }: { items: Article[] }) {
  return (
    <ul className="rk-queue">
      {items.map((x) => (
        <li key={x.id}>
          <Link to="/help" search={{ a: x.id }} className="rk-queue__row">
            <span className="rk-queue__sentence">{x.title}</span>
            <span className="rk-small rk-muted">{x.summary}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Diagnostics({ report, error }: { report?: DoctorReport; error: Error | null }) {
  if (error)
    return (
      <p role="alert" className="rk-small">
        Diagnostics couldn't run: {error.message}. In a terminal, run{" "}
        <code className="rk-mono">rocky doctor</code>.
      </p>
    );
  if (!report) return null;
  const order = { fail: 0, warn: 1, pass: 2 } as const;
  const checks = [...report.checks].sort((x, y) => order[x.status] - order[y.status]);
  return (
    <section className="rk-section" aria-labelledby="help-diag">
      <h2 id="help-diag" className="rk-h2">
        {report.ok ? "Everything needed is working" : "Something needs attention"}
      </h2>
      <ul className="rk-help__checks">
        {checks.map((c) => (
          <li key={c.id}>
            <Chip tone={TONE[c.status]}>{WORD[c.status]}</Chip>
            <span>
              <strong>{c.label}</strong> <span className="rk-muted">{c.detail}</span>
              {c.hint && <span className="rk-help__hint">{c.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

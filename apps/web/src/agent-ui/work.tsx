import type { RockyEvent } from "@rocky/contracts";
import {
  BookOpen,
  CircleCheck,
  Hand,
  type LucideIcon,
  MessageSquare,
  OctagonX,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "../ui/index.tsx";
import "./agent-ui.css";
import { elapsed, type RunView, receiptText, type StepView } from "./runs.ts";
import { StatusChip } from "./StatusChip.tsx";
import { STATUS } from "./status.ts";

/** The receipt line (UI spec "Receipt"): tool, verb, count, what did not happen. */
export function Receipt({
  event,
  onOpen,
}: {
  event: Extract<RockyEvent, { kind: "receipt" }>;
  onOpen?: () => void;
}) {
  const [main, not] = receiptText(event).split(" · ");
  return (
    <button type="button" className="rk-receipt" onClick={onOpen}>
      <CircleCheck size={16} strokeWidth={1.5} className="rk-receipt__icon" aria-hidden />
      <span>
        {main}
        {not && <span className="rk-receipt__not"> · {not}</span>}
      </span>
    </button>
  );
}

/** One run's steps in order; planned steps outlined; a failed step opens with three lines. */
export function Timeline({
  steps,
  selected,
  onSelect,
}: {
  steps: StepView[];
  /** With onSelect, each step is a button that shows its detail. */
  selected?: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <ol className="rk-timeline">
      {steps.map((s, i) => {
        const Icon = STATUS[s.state].icon;
        return (
          <li key={s.seq} className="rk-timeline__step" data-planned={s.planned}>
            <span
              className="rk-timeline__node"
              style={{
                color: s.state === "failed" ? "var(--color-error-text)" : "var(--color-text-2)",
              }}
            >
              <Icon size={14} strokeWidth={2} aria-hidden />
            </span>
            <div>
              {(() => {
                const text = (
                  <span className="rk-timeline__text">
                    <span className="sr-only">
                      {s.planned ? "Planned: " : `${STATUS[s.state].word}: `}
                    </span>
                    {s.sentence}
                  </span>
                );
                return onSelect ? (
                  <button
                    type="button"
                    className="rk-step-btn"
                    aria-current={i === selected ? "true" : undefined}
                    onClick={() => onSelect(i)}
                  >
                    {text}
                  </button>
                ) : (
                  text
                );
              })()}
              {s.error && (
                <section className="rk-timeline__fail" aria-label="What went wrong">
                  <span>
                    <strong>What happened:</strong> {s.error.message}
                  </span>
                  {s.error.tried && (
                    <span>
                      <strong>What Rocky tried:</strong> {s.error.tried}
                    </span>
                  )}
                  {s.error.youCan && (
                    <span>
                      <strong>What you can do:</strong> {s.error.youCan}
                    </span>
                  )}
                </section>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const KIND_ICON: Record<RockyEvent["kind"], LucideIcon> = {
  message: MessageSquare,
  status: Wrench,
  receipt: CircleCheck,
  approval: Hand,
  memory: BookOpen,
  error: OctagonX,
};

/** The sentence for any event (ledger rows, notifications): action and target first. */
export function eventSentence(e: RockyEvent): string {
  switch (e.kind) {
    case "message":
      return `${e.role === "user" ? "You" : "Rocky"}: ${e.text}`;
    case "status":
      return `${e.title}: ${STATUS[e.state].word}${e.line ? ` · ${e.line}` : ""}`;
    case "receipt":
      return receiptText(e);
    case "approval":
      return `${e.change[0]?.toUpperCase()}${e.change.slice(1)}: ${e.title}`;
    case "memory":
      return `${e.change === "used" ? "Used memory" : e.change === "learned" ? "Noted" : "Forgot"}: ${e.text}`;
    case "error":
      return e.message;
  }
}

export const isPlanned = (e: RockyEvent) =>
  e.kind === "approval" && (e.change === "proposed" || e.change === "approved");

const time = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** A ledger row (UI spec "Activity row"). */
export function ActivityRow({
  event,
  worker,
  actions,
}: {
  event: RockyEvent;
  worker?: string;
  actions?: ReactNode;
}) {
  const Icon = KIND_ICON[event.kind];
  return (
    <li className="rk-activity" data-planned={isPlanned(event)}>
      <time className="rk-activity__time" dateTime={new Date(event.at).toISOString()}>
        {time(event.at)}
      </time>
      <div className="rk-activity__main">
        <Icon
          size={16}
          strokeWidth={1.5}
          aria-hidden
          style={{
            color: event.kind === "error" ? "var(--color-error-text)" : "var(--color-text-2)",
          }}
        />
        <span className="rk-activity__sentence">
          {isPlanned(event) && <span className="sr-only">Planned: </span>}
          {eventSentence(event)}
        </span>
        {worker && <span className="rk-activity__worker">{worker}</span>}
        {actions}
      </div>
    </li>
  );
}

/** Collapsed by default: tool, target, duration. Expanded: arguments and output in mono. */
export function ToolCallBlock({
  tool,
  target,
  durationMs,
  args,
  output,
}: {
  tool: string;
  target: string;
  durationMs?: number;
  args: unknown;
  output?: unknown;
}) {
  return (
    <details className="rk-tool">
      <summary>
        <Wrench size={16} strokeWidth={1.5} aria-hidden />
        <strong>{tool}</strong>
        <span className="rk-muted">{target}</span>
        {durationMs !== undefined && (
          <span className="rk-muted" style={{ marginLeft: "auto" }}>
            {elapsed(durationMs)}
          </span>
        )}
      </summary>
      <pre className="rk-mono">
        {JSON.stringify({ args, ...(output === undefined ? {} : { output }) }, null, 2)}
      </pre>
    </details>
  );
}

/** A run as a card (UI spec "Task card"): title, status chip, current step, time, one action. */
export function TaskCard({ run, now, action }: { run: RunView; now: number; action?: ReactNode }) {
  return (
    <Card as="article" className="rk-task" aria-label={run.title}>
      <div className="rk-task__head">
        <h3 className="rk-h3 rk-task__title">{run.title}</h3>
        <StatusChip state={run.state} {...(run.step ? { detail: { step: run.step } } : {})} />
      </div>
      {run.line && <p className="rk-task__line">{run.line}</p>}
      <div className="rk-task__head">
        <span className="rk-small rk-muted" style={{ flex: 1 }}>
          {run.state === "completed" || run.state === "failed"
            ? `${STATUS[run.state].word} in ${elapsed(run.updatedAt - run.startedAt)}`
            : `${elapsed(now - run.startedAt)} so far`}
        </span>
        {action}
      </div>
    </Card>
  );
}

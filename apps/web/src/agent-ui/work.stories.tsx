import type { RockyEvent } from "@rocky/contracts";
import type { Meta, Story } from "../stories/catalog.ts";
import { Button } from "../ui/index.tsx";
import { foldRuns } from "./runs.ts";
import { ActivityRow, Receipt, TaskCard, Timeline, ToolCallBlock } from "./work.tsx";

export default { title: "Agent/Work" } satisfies Meta;

const T = Date.UTC(2026, 9, 8, 9, 0);
let seq = 0;
const ev = (e: Record<string, unknown>) =>
  ({ seq: ++seq, at: T + seq * 60_000, ...e }) as RockyEvent;

const sync = [
  ev({
    kind: "status",
    runId: "s1",
    state: "background",
    runKind: "sync",
    title: "Syncing Gmail",
    line: "Reading Gmail",
  }),
  ev({
    kind: "receipt",
    runId: "s1",
    tool: "Gmail",
    verb: "synced",
    count: 12,
    unit: "items",
    notDone: "0 changed in Gmail",
  }),
  ev({ kind: "status", runId: "s1", state: "completed", runKind: "sync", title: "Syncing Gmail" }),
];
const failed = [
  ev({
    kind: "status",
    runId: "j1",
    state: "working",
    runKind: "job",
    title: "Transcribing a recording",
    line: "Transcribing minute 3 of 41",
    step: { n: 2, of: 4 },
  }),
  ev({
    kind: "receipt",
    runId: "j1",
    tool: "Files",
    verb: "read",
    count: 1,
    unit: "recording",
    notDone: "0 changed",
  }),
  ev({
    kind: "error",
    runId: "j1",
    code: "JOB_FAILED",
    message: "ffmpeg was not found.",
    tried: "Attempt 1 of 3.",
    youCan: "Run rocky doctor --fix, then retry.",
  }),
];
const action = [
  ev({
    kind: "approval",
    runId: "a1",
    actionId: "a1",
    change: "proposed",
    title: "Create GitHub issue: Fix Safari login",
    risk: "medium",
    review: "standard",
  }),
  ev({
    kind: "approval",
    runId: "a1",
    actionId: "a1",
    change: "approved",
    title: "Create GitHub issue: Fix Safari login",
    risk: "medium",
    review: "standard",
  }),
];

export const ReceiptLine: Story = () => (
  <Receipt event={sync[1] as Extract<RockyEvent, { kind: "receipt" }>} onOpen={() => {}} />
);
ReceiptLine.parameters = { states: ["hover", "focus"] };

export const TimelineFailed: Story = () => (
  <Timeline steps={foldRuns(failed).get("j1")?.steps ?? []} />
);
TimelineFailed.storyName = "Timeline: failed step opens";

export const TimelinePlanned: Story = () => (
  <Timeline steps={foldRuns(action).get("a1")?.steps ?? []} />
);
TimelinePlanned.storyName = "Timeline: planned outlined";

export const LedgerRows: Story = () => (
  <ul style={{ listStyle: "none", padding: 0, margin: 0, maxWidth: 760 }}>
    {[...sync, ...failed, ...action].map((e) => (
      <ActivityRow key={e.seq} event={e} worker={e.kind === "receipt" ? e.tool : undefined} />
    ))}
  </ul>
);

export const TaskCards: Story = () => {
  const runs = foldRuns([
    ...sync,
    ...failed,
    ev({
      kind: "status",
      runId: "w",
      state: "working",
      runKind: "routine",
      title: "Routine: Monday brief",
      line: "Reading 12 notes in ~/notes",
      step: { n: 3, of: 7 },
    }),
  ]);
  return (
    <div style={{ display: "grid", gap: "var(--space-3)", maxWidth: 560 }}>
      {[...runs.values()].map((r) => (
        <TaskCard key={r.id} run={r} now={T + 20 * 60_000} action={<Button dense>Open</Button>} />
      ))}
    </div>
  );
};

export const ToolCall: Story = () => (
  <div style={{ maxWidth: 560 }}>
    <ToolCallBlock
      tool="github.issueCreate"
      target="o/r"
      durationMs={840}
      args={{ repo: "o/r", title: "Fix Safari login" }}
      output={{ number: 143 }}
    />
  </div>
);
ToolCall.parameters = { states: ["focus"] };

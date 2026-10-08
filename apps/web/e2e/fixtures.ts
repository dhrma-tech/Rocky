import type { Page, Route } from "@playwright/test";

/**
 * A fake daemon for screen tests: every /api/v1 call is answered here, so screens render their
 * populated, empty, loading and error states without a running engine or any network.
 */

export type Scenario = "populated" | "empty" | "loading" | "error" | "engine-down";

const NOW = Date.now();
const MIN = 60_000;

const action = (over: Record<string, unknown>) => ({
  id: "01JAPPROVAL0000000000000001",
  type: "github.issueCreate",
  title: "Create GitHub issue",
  connectorId: "github",
  payload: {
    repo: "acme/web",
    title: "Fix Safari login loop",
    body: "Users on Safari 17 loop back to sign-in.",
  },
  payloadHash: "9f2c4b1e7a0d3c5f8e6b2a4d1c9e7f3a5b8d0c2e4f6a8b1d3c5e7f9a0b2c4d6e",
  risk: "medium",
  status: "draft",
  origin: "user_turn",
  citations: [
    {
      chunkId: "c1",
      documentId: "d1",
      title: "Standup, 7 Oct",
      anchor: { kind: "text" },
      quote: "Ana will open a ticket for the Safari login loop",
    },
  ],
  suspicious: false,
  provenance: [],
  review: "standard",
  actionClass: "write",
  description: { target: "acme/web", summary: "Fix Safari login loop" },
  idempotencyKey: "k1",
  approvedAt: null,
  approvedBy: null,
  executeAfter: null,
  result: null,
  error: null,
  createdAt: NOW - 42 * MIN,
  updatedAt: NOW - 42 * MIN,
  ...over,
});

export const DRAFTS = [
  action({}),
  action({
    id: "01JAPPROVAL0000000000000002",
    type: "gmail.draftCreate",
    title: "Create Gmail draft",
    connectorId: "gmail",
    risk: "low",
    payload: {
      threadId: "t1",
      to: ["dana@acme.dev"],
      cc: [],
      subject: "Re: annual plan",
      body: "Hi Dana,\n\nAnnual works for us.\n\nSam",
    },
    description: { target: "dana@acme.dev", summary: "Re: annual plan" },
    review: "strict",
    provenance: [
      {
        documentId: "m1",
        title: "Re: annual plan",
        sourceType: "email",
        connectorId: "gmail",
        external: true,
        flags: [],
      },
    ],
    createdAt: NOW - 12 * MIN,
  }),
];

let seq = 0;
const ev = (e: Record<string, unknown> & { runId?: string }, ago: number) => ({
  seq: ++seq,
  at: NOW - ago * MIN,
  ...e,
});
export const EVENTS = [
  ev(
    {
      kind: "status",
      runId: "sync1",
      state: "background",
      runKind: "sync",
      title: "Syncing Gmail",
      line: "Reading Gmail",
    },
    50,
  ),
  ev(
    {
      kind: "receipt",
      runId: "sync1",
      tool: "Gmail",
      verb: "synced",
      count: 12,
      unit: "items",
      notDone: "0 changed in Gmail",
    },
    49,
  ),
  ev(
    { kind: "status", runId: "sync1", state: "completed", runKind: "sync", title: "Syncing Gmail" },
    49,
  ),
  ev(
    {
      kind: "approval",
      runId: DRAFTS[0]?.id,
      actionId: DRAFTS[0]?.id,
      change: "proposed",
      title: "Create GitHub issue: Fix Safari login loop",
      risk: "medium",
      review: "standard",
    },
    42,
  ),
  ev(
    {
      kind: "status",
      runId: "job1",
      state: "working",
      runKind: "job",
      title: "Transcribing a recording",
      line: "Transcribing minute 3 of 41",
      step: { n: 2, of: 4 },
    },
    8,
  ),
  ev(
    {
      kind: "status",
      runId: "job2",
      state: "working",
      runKind: "job",
      title: "Extracting decisions and commitments",
    },
    30,
  ),
  ev(
    {
      kind: "error",
      runId: "job2",
      code: "JOB_FAILED",
      message: "The local model did not answer in time.",
      tried: "Attempt 3 of 3.",
      youCan: "Check that Ollama is running, then run it again.",
    },
    29,
  ),
  ev(
    {
      kind: "status",
      runId: "job2",
      state: "failed",
      runKind: "job",
      title: "Extracting decisions and commitments",
    },
    29,
  ),
];

const HOME = {
  today: [
    {
      kind: "event",
      title: "Pricing review",
      start: NOW + 90 * MIN,
      end: NOW + 120 * MIN,
      due: null,
      allDay: false,
      source: "gcal",
      deepLink: null,
      documentId: "ev1",
    },
  ],
  dueSoon: [
    {
      id: "c1",
      text: "Send Dana the annual quote",
      ownerEntityId: null,
      ownerName: "You",
      counterpartyName: "Dana",
      deadline: NOW + 2 * 86_400_000,
      deadlineText: "Friday",
      status: "open",
      documentId: "d1",
      documentTitle: "Standup",
      meetingId: null,
      chunkId: null,
      anchor: { kind: "text" },
    },
  ],
  overdue: [],
  pendingApprovals: 2,
  lastRun: null,
};

const ROUTINES = {
  routines: [
    {
      id: "r1",
      name: "Monday brief",
      pack: null,
      template: null,
      schedule: "0 8 * * 1",
      enabled: true,
      inputs: [],
      prompt: "",
      edited: false,
      lastRunAt: null,
      nextRunAt: NOW + 3 * 86_400_000,
      lastRun: null,
    },
  ],
};

const MEMORY = {
  dir: "E:/RockyData/memory",
  files: [
    {
      path: "preferences.md",
      group: "Preferences",
      title: "Preferences",
      facts: [
        { text: "Short answers first", provenance: { by: "user", at: NOW - 3 * 86_400_000 } },
        {
          text: "Prefers annual billing for tools",
          provenance: {
            by: "source",
            doc: "d1",
            title: "Call with Dana",
            quote: "we only sign annual",
            at: NOW - 86_400_000,
          },
        },
      ],
      hash: "h1",
      updatedAt: NOW - 86_400_000,
    },
    {
      path: "people/dana.md",
      group: "People",
      title: "Dana",
      facts: [],
      hash: "h2",
      updatedAt: NOW - 2 * 86_400_000,
    },
  ],
};
const MEMORY_DRAFT = action({
  id: "01JAPPROVAL0000000000000009",
  type: "memory.add",
  title: "Remember",
  connectorId: null,
  risk: "low",
  payload: {
    file: "people/dana.md",
    fact: "Dana only signs annual contracts",
    documentId: "d1",
    quote: "she only signs annual contracts",
  },
  description: { target: "people/dana.md", summary: "Dana only signs annual contracts" },
});
const PROJECTS = [
  {
    id: "p1",
    name: "Launch",
    folder: "E:/Work/Launch",
    notebookId: "n1",
    folderExists: true,
    documentCount: 14,
    createdAt: NOW - 9 * 86_400_000,
    archivedAt: null,
  },
  {
    id: "p2",
    name: "Thesis",
    folder: "E:/Uni/Thesis",
    notebookId: "n2",
    folderExists: false,
    documentCount: 31,
    createdAt: NOW - 30 * 86_400_000,
    archivedAt: null,
  },
];

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Answers /api/v1/* for one scenario. Unknown calls get an empty object so nothing hangs. */
export async function mockApi(page: Page, scenario: Scenario) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1", "");
    const method = route.request().method();
    // The live stream stays open and silent: the page shows "live", not "reconnecting".
    if (path === "/events") return;
    if (scenario === "engine-down")
      return json(route, { error: "engine down", code: "UNAVAILABLE" }, 503);
    if (path === "/settings")
      return json(route, {
        localOnly: true,
        budget: { monthlyCapUsd: 10 },
        ollama: { baseUrl: "" },
        dataDir: "E:/RockyData",
        secrets: {},
      });
    if (scenario === "loading") return; // never answers
    if (scenario === "error" && path.startsWith("/actions"))
      return json(route, { error: "The store could not be read.", code: "INTERNAL" }, 500);
    const full = scenario === "populated";
    if (path === "/actions" && method === "GET") {
      const status = url.searchParams.get("status");
      return json(route, { actions: full && status === "draft" ? [...DRAFTS, MEMORY_DRAFT] : [] });
    }
    if (path === "/events/page") {
      const events = full ? EVENTS : [];
      const runId = url.searchParams.get("runId");
      const shown = runId ? events.filter((e) => e.runId === runId) : events;
      return json(route, { events: shown, last: shown.at(-1)?.seq ?? 0 });
    }
    if (path === "/home")
      return json(route, full ? HOME : { ...HOME, today: [], dueSoon: [], pendingApprovals: 0 });
    if (path === "/routines") return json(route, full ? ROUTINES : { routines: [] });
    if (path === "/recordings/active") return json(route, { recordings: [] });
    if (path === "/memory") return json(route, full ? MEMORY : { dir: MEMORY.dir, files: [] });
    if (path === "/memory/file")
      return json(route, { content: "# Preferences\n\n- Short answers first\n", hash: "h1" });
    if (path === "/projects") return json(route, { projects: full ? PROJECTS : [] });
    if (path.startsWith("/projects/"))
      return json(route, PROJECTS.find((p) => path.endsWith(p.id)) ?? PROJECTS[0]);
    return json(route, {});
  });
}

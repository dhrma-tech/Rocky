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

const run = (status: "done" | "failed", at: number, error: string | null = null) => ({
  id: `run-${at}`,
  routineId: "r",
  startedAt: at,
  finishedAt: at + 60_000,
  status,
  answer: [],
  notFound: status === "done",
  error,
  path: null,
});
const routine = (o: Record<string, unknown>) => ({
  pack: null,
  template: null,
  inputs: ["overdue"],
  prompt: "Summarise.",
  edited: false,
  file: null,
  lastRunAt: null,
  nextRunAt: null,
  lastRun: null,
  recent: [],
  autoPaused: false,
  ...o,
});
export const RUNS = [
  {
    id: "ask:1",
    kind: "ask",
    title: "Ask: What did Dana agree to on pricing?",
    state: "completed",
    startedAt: NOW - 3_600_000,
    updatedAt: NOW - 3_480_000,
    receipts: 1,
    outcome: "Ask → cited 3 sources · 0 changed",
    archived: false,
    routineId: null,
  },
  {
    id: "job-r1",
    kind: "routine",
    title: "Routine: Monday brief",
    state: "failed",
    startedAt: NOW - 86_400_000,
    updatedAt: NOW - 86_340_000,
    receipts: 0,
    outcome: "Ollama is not running at http://127.0.0.1:11434.",
    archived: false,
    routineId: "r1",
  },
  {
    id: "sync-1",
    kind: "sync",
    title: "Syncing Gmail",
    state: "completed",
    startedAt: NOW - 2 * 86_400_000,
    updatedAt: NOW - 2 * 86_400_000 + 12_000,
    receipts: 1,
    outcome: "Gmail → synced 12 items",
    archived: false,
    routineId: null,
  },
];

export const ROUTINES = {
  routines: [
    routine({
      id: "r1",
      name: "Monday brief",
      schedule: "0 8 * * 1",
      enabled: true,
      nextRunAt: NOW + 3 * 86_400_000,
      lastRun: run("done", NOW - 4 * 86_400_000),
      recent: ["done", "done", "failed", "done"],
    }),
    routine({
      id: "r2",
      name: "Deadline digest",
      schedule: "0 18 * * 0",
      enabled: false,
      autoPaused: true,
      lastRun: run("failed", NOW - 86_400_000, "Ollama is not running at http://127.0.0.1:11434."),
      recent: ["failed", "failed", "failed", "done", "done"],
    }),
    routine({ id: "r3", name: "End of day", schedule: "0 17 * * 1-5", enabled: false }),
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

const RULES = [
  {
    id: "rule1",
    effect: "block",
    connectorId: "gmail",
    actionType: null,
    actionClass: "delete",
    constraints: [],
    expiresAt: null,
    usesLeft: null,
    fromActionId: null,
    note: "",
    sentence: "Rocky never deletes anything in Gmail.",
    createdAt: NOW - 5 * 86_400_000,
    revokedAt: null,
    active: true,
  },
];
const entry = (kind: string, displayName: string, tier: string, oauthGroup: string | null) => ({
  kind,
  displayName,
  permissions: `Reads your ${displayName} items. Drafts only; never sends.`,
  configSchema: {},
  secrets: [],
  oauthGroup,
  actions: [],
  defaultIntervalMin: 15,
  plugin: false,
  tier,
});
const CATALOG = [
  entry("gmail", "Gmail", "experimental", "google-oauth"),
  entry("github", "GitHub", "experimental", null),
  entry("notion", "Notion", "experimental", null),
];
const connector = (kind: string, displayName: string, status: string, message: string | null) => ({
  id: kind,
  kind,
  displayName,
  enabled: true,
  readOnly: false,
  config: {},
  status,
  message,
  tier: "experimental",
  intervalMin: 15,
  lastSyncAt: NOW - 600_000,
  lastSuccessAt: NOW - 600_000,
  nextSyncAt: NOW + 300_000,
  lastError: null,
  cursor: {},
  documentCount: 214,
  lastRun: null,
  createdAt: NOW - 9 * 86_400_000,
});
const CONNECTORS = [
  connector("gmail", "Gmail", "connected", null),
  connector("github", "GitHub", "needs_reconnect", "Your GitHub token expired. Paste a new one."),
];
const MODELS = {
  ollama: true,
  hardware: { ramGb: 15.7, cuda: false, cores: 8 },
  current: { small: "qwen3:1.7b", medium: "qwen3:4b" },
  speed: {
    model: "qwen3:4b",
    tokensPerSecond: 8.4,
    promptTokensPerSecond: 52.5,
    firstTokenMs: 900,
    estimatedAnswerSeconds: 105,
    measuredAt: NOW - 86_400_000,
  },
  models: [
    { name: "qwen3:4b", sizeGb: 2.6, canAnswer: true, fit: "fits", why: "uses 17% of RAM" },
    { name: "nomic-embed-text", sizeGb: 0.3, canAnswer: false, fit: "fits", why: "" },
  ],
  small: "qwen3:1.7b",
  medium: "qwen3:4b",
  note: "These fit comfortably in 15.7 GB.",
};

const SETTINGS = {
  localOnly: true,
  budget: { monthlyCapUsd: 10 },
  ollama: { baseUrl: "" },
  notifications: {
    system: { needsYou: true, updates: false, headsUp: true },
    phone: { needsYou: true, updates: false, headsUp: true },
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
  },
  dataDir: "E:/RockyData",
  secrets: {},
};

export const NOTIFICATIONS = {
  unread: 2,
  notifications: [
    {
      id: "01JZ0000000000000000000003",
      at: NOW - 60_000,
      kind: "needs_you",
      sentence: "Needs your approval: Draft a reply to Priya: pricing question",
      link: "/approvals",
      actionLabel: "Review",
      runId: "a1",
      readAt: null,
      snoozedUntil: null,
    },
    {
      id: "01JZ0000000000000000000002",
      at: NOW - 3_600_000,
      kind: "update",
      sentence: "Routine: Morning brief finished.",
      link: "/runs/r1",
      actionLabel: "Open",
      runId: "r1",
      readAt: null,
      snoozedUntil: null,
    },
    {
      id: "01JZ0000000000000000000001",
      at: NOW - 2 * 86_400_000,
      kind: "system",
      sentence: "Weekly review failed 3 times in a row, so Rocky paused it.",
      link: "/tasks/background",
      actionLabel: "Open",
      runId: null,
      readAt: NOW - 86_400_000,
      snoozedUntil: null,
    },
  ],
};

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
    if (path === "/settings" && method === "PUT")
      return json(route, { ...SETTINGS, ...(route.request().postDataJSON() as object) });
    if (path === "/settings") return json(route, SETTINGS);
    if (scenario === "loading") return; // never answers
    if (
      scenario === "error" &&
      (path.startsWith("/actions") ||
        path === "/routines" ||
        path === "/runs" ||
        path === "/notifications" ||
        path === "/files" ||
        path === "/connectors")
    )
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
    if (path === "/routines" && method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, routine({ id: "r9", enabled: true, ...body }), 201);
    }
    if (path === "/routines") return json(route, full ? ROUTINES : { routines: [] });
    if (path === "/runs") return json(route, { runs: full ? RUNS : [] });
    if (path === "/devices")
      return json(route, {
        devices: full
          ? [
              {
                id: "01JDEV0000000000000000001",
                name: "Pixel 8",
                createdAt: NOW - 3 * 86_400_000,
                expiresAt: NOW + 80 * 86_400_000,
                lastSeenAt: NOW - 5 * MIN,
                revokedAt: null,
              },
            ]
          : [],
        hosts: full ? ["pc.tail1234.ts.net"] : [],
        port: 7337,
      });
    if (path === "/devices/pair-code")
      return json(route, { code: "482913", expiresAt: Date.now() + 300_000 });
    if (path === "/devices/hosts") return json(route, route.request().postDataJSON());
    if (path.startsWith("/devices/") && path.endsWith("/revoke"))
      return json(route, { revoked: "x" });
    if (path === "/notifications")
      return json(route, full ? NOTIFICATIONS : { unread: 0, notifications: [] });
    if (path.startsWith("/notifications/")) return json(route, { changed: 1 });
    if (path === "/files")
      return json(route, {
        files: full
          ? [
              {
                documentId: "f1",
                name: "pricing-notes.md",
                path: "C:\\Users\\dana\\Notes\\pricing-notes.md",
                mime: "text/markdown",
                readAt: NOW - 3_600_000,
                size: 18_432,
                exists: true,
                textChars: 9_120,
              },
              {
                documentId: "f2",
                name: "old-plan.pdf",
                path: "C:\\Users\\dana\\Notes\\archive\\a-very-long-folder-name-that-should-wrap\\old-plan.pdf",
                mime: "application/pdf",
                readAt: NOW - 5 * 86_400_000,
                size: null,
                exists: false,
                textChars: 2_400,
              },
            ]
          : [],
      });
    if (path.startsWith("/files/") && path.endsWith("/preview"))
      return json(route, { text: "# Pricing\n\nDana prefers annual billing.", truncated: true });
    if (path.startsWith("/files/") && path.endsWith("/reveal"))
      return json(route, { revealed: true });
    if (path.startsWith("/documents/") && method === "DELETE")
      return json(route, { deleted: true });
    if (path === "/health") return json(route, { ok: true, version: "0.9.0" });
    if (path === "/onboarding") {
      const saved = {
        step: 4,
        name: "Rocky",
        swatch: "periwinkle",
        preset: "ask-everything",
        readOnlyRuleId: null,
        completedAt: NOW - 86_400_000,
        userName: full ? "Dana Whitfield" : null,
        firstRun: false,
      };
      if (method === "PATCH")
        return json(route, { ...saved, ...(route.request().postDataJSON() as object) });
      return json(route, saved);
    }
    if (path === "/system/diagnostics")
      return json(route, {
        generatedAt: NOW,
        dataDir: "C:/Users/dana/RockyData",
        dataDirSource: "flag",
        hardware: {
          platform: "win32",
          release: "10.0.26200",
          cpu: "Intel",
          cores: 8,
          ramGb: 15.7,
          ramTier: "high",
          gpus: [],
          cuda: false,
        },
        ollamaModels: [],
        checks: [
          { id: "node", label: "Node.js", status: "pass", detail: "v24.11.1" },
          {
            id: "ollama",
            label: "Ollama",
            status: "fail",
            detail: "not reachable at http://127.0.0.1:11434",
            hint: "Install it from ollama.com/download and start it.",
          },
          {
            id: "disk",
            label: "Free disk",
            status: "warn",
            detail: "8 GB free on C:\\Users\\dana",
          },
        ],
        ok: false,
      });
    if (path === "/runs/archive") return json(route, { archived: 1 });
    if (path === "/runs/unarchive") return json(route, { restored: 1 });
    if (path === "/routines/pause-all") return json(route, { paused: ["r1"] });
    if (path === "/templates")
      return json(route, {
        packs: [
          {
            id: "student",
            name: "Student",
            description: "Classes and deadlines.",
            routines: [{ template: "morning", name: "Morning brief", schedule: "0 7 * * 1-5" }],
          },
        ],
      });
    if (path === "/recordings/active") return json(route, { recordings: [] });
    if (path === "/memory") return json(route, full ? MEMORY : { dir: MEMORY.dir, files: [] });
    if (path === "/memory/file")
      return json(route, { content: "# Preferences\n\n- Short answers first\n", hash: "h1" });
    if (path === "/connectors/catalog") return json(route, { catalog: CATALOG });
    if (path === "/connectors" && method === "GET")
      return json(route, { connectors: full ? CONNECTORS : [] });
    if (/^\/connectors\/[^/]+\/runs$/.test(path))
      return json(route, {
        runs: [
          {
            id: "cr1",
            connectorId: "gmail",
            startedAt: NOW - 600_000,
            finishedAt: NOW - 590_000,
            status: "ok",
            added: 3,
            updated: 1,
            deleted: 0,
            requests: 7,
            full: false,
            error: null,
          },
        ],
      });
    if (path === "/imports/archives") return json(route, { imports: [] });
    if (path === "/rules" && method === "POST") return json(route, { ...RULES[0], id: "rule2" });
    if (/^\/rules\/[^/]+\/revoke$/.test(path)) return json(route, { ...RULES[0], revokedAt: NOW });
    if (path === "/rules") return json(route, { rules: full ? RULES : [] });
    if (path === "/rules/preview")
      return json(route, { sentence: "Rocky always asks before any action." });
    if (path === "/models")
      return json(route, full ? MODELS : { ...MODELS, models: [], speed: null });
    if (path === "/storage") return json(route, { configured: true, encrypted: full });
    if (path === "/usage")
      return json(route, { month: "2026-10", spentUsd: full ? 1.2 : 0, capUsd: 10, rows: [] });
    if (path === "/projects") return json(route, { projects: full ? PROJECTS : [] });
    if (path.startsWith("/projects/"))
      return json(route, PROJECTS.find((p) => path.endsWith(p.id)) ?? PROJECTS[0]);
    return json(route, {});
  });
}

import type {
  ActionRecord,
  ActionRule,
  ActionStatus,
  ArchiveImportResult,
  ArchiveImportRow,
  AskEvent,
  AskRequest,
  AskResult,
  AuditRow,
  AuditVerify,
  Brief,
  BriefRequest,
  Card,
  Citation,
  Commitment,
  CommitmentPatch,
  CommitmentStatus,
  Connector,
  ConnectorCatalogEntry,
  ConnectorHealth,
  ConnectorRun,
  ConnectorUpdate,
  Countdown,
  Decision,
  DraftRequest,
  Entity,
  EventsPage,
  Hardware,
  HomeSummary,
  JobEvent,
  Meeting,
  MeetingDetail,
  MeetingKind,
  MindMap,
  Notebook,
  NotebookCreate,
  NotebookSource,
  NotebookUpdate,
  QuizCreate,
  QuizGrade,
  QuizQuestion,
  Rating,
  RecordingStart,
  ReviewQueue,
  RockyEvent,
  Routine,
  RoutineCreate,
  RoutineRun,
  RoutineUpdate,
  RuleCreate,
  RulePreview,
  ScopeRules,
  SettingsUpdate,
  StudyGuide,
  TimelineItem,
  TranscriptSegment,
  WorkloadItem,
} from "@rocky/contracts";

export type StudyTask = "cards" | "summaries" | "guide" | "mindmap";

/** Error from the daemon: `code` is stable (BUDGET_EXCEEDED, EGRESS_BLOCKED, …), message is shown verbatim. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  return new ApiError(res.status, body.code ?? `HTTP_${res.status}`, body.error ?? res.statusText);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** Binary PUT for recording chunks (no JSON content type). */
async function putBytes(path: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(`/api/v1${path}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/octet-stream" },
    body: bytes as BodyInit,
  });
  if (!res.ok) throw await toError(res);
}

/**
 * Streams a file to POST /imports/media. XMLHttpRequest because fetch can't report upload
 * progress, and a lecture video can be a gigabyte.
 */
export function uploadMedia(
  file: File,
  opts: { kind: MeetingKind; onProgress?: (p: number) => void },
): Promise<{ meetingId: string; jobId: string }> {
  const q = new URLSearchParams({ filename: file.name, kind: opts.kind });
  return uploadFile(`/api/v1/imports/media?${q}`, file, opts.onProgress);
}

/** Streams a chat export (zip, .txt, tweets.js, CSV) to POST /imports/archive. */
export function uploadArchive(
  file: File,
  onProgress?: (p: number) => void,
): Promise<ArchiveImportResult> {
  const q = new URLSearchParams({ filename: file.name });
  return uploadFile(`/api/v1/imports/archive?${q}`, file, onProgress);
}

function uploadFile<T>(url: string, file: File, onProgress?: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: { error?: string; code?: string } = {};
      try {
        body = JSON.parse(xhr.responseText || "{}") as typeof body;
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else
        reject(
          new ApiError(xhr.status, body.code ?? `HTTP_${xhr.status}`, body.error ?? xhr.statusText),
        );
    };
    xhr.onerror = () =>
      reject(new ApiError(0, "NETWORK", "Upload failed: the daemon is not reachable."));
    xhr.send(file);
  });
}

/** GET /jobs/:id/events (SSE). Returns a function that closes the stream. */
export function watchJob(id: string, onEvent: (e: JobEvent) => void): () => void {
  const es = new EventSource(`/api/v1/jobs/${encodeURIComponent(id)}/events`, {
    withCredentials: true,
  });
  const handle = (m: MessageEvent<string>) => onEvent(JSON.parse(m.data) as JobEvent);
  for (const t of ["progress", "done", "failed"]) es.addEventListener(t, handle as EventListener);
  // The server ends the stream when the job finishes; don't let EventSource reconnect forever.
  es.onerror = () => es.close();
  return () => es.close();
}

export type StreamState = "live" | "reconnecting";

/**
 * GET /events (SSE): the typed event stream. EventSource reconnects by itself and sends the last
 * id it saw, so the daemon replays exactly what was missed ("Connection lost. Reconnecting…").
 * Events arrive in seq order; duplicates (a replay overlapping what was shown) are dropped here.
 */
export function subscribeEvents(
  after: number,
  onEvent: (e: RockyEvent) => void,
  onState: (s: StreamState) => void = () => {},
): () => void {
  let last = after;
  const es = new EventSource(`/api/v1/events?after=${after}`, { withCredentials: true });
  const handle = (m: MessageEvent<string>) => {
    // The browser also fires a data-less "error" when the connection drops; our "error" kind has data.
    if (typeof m.data !== "string") return;
    const e = JSON.parse(m.data) as RockyEvent;
    if (e.seq <= last) return;
    last = e.seq;
    onEvent(e);
  };
  for (const k of ["message", "status", "receipt", "approval", "memory", "error"] as const)
    es.addEventListener(k, handle as EventListener);
  es.onopen = () => onState("live");
  es.onerror = () => onState("reconnecting");
  return () => es.close();
}

export interface Settings {
  localOnly: boolean;
  budget: { monthlyCapUsd: number };
  ollama: { baseUrl: string };
  dataDir: string;
  secrets: Record<string, boolean>;
}

export interface Usage {
  month: string;
  spentUsd: number;
  capUsd: number;
  rows: {
    task: string;
    provider: string;
    model: string;
    local: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[];
}

export type AnchorView =
  | {
      viewer: "pdf";
      title: string;
      blobUrl: string;
      page: number;
      charStart: number;
      charEnd: number;
    }
  | {
      viewer: "transcript";
      title: string;
      meetingId: string;
      audioUrl: string | null;
      startMs: number;
      endMs: number;
      segments: TranscriptSegment[];
    }
  | {
      viewer: "external";
      title: string;
      /** Deep link to the item in its app (GitHub, Notion, Gmail, Calendar). */
      url: string;
      text: string;
      charStart: number;
      charEnd: number;
      anchor: { kind: string };
    }
  | {
      viewer: "text";
      title: string;
      text: string;
      charStart: number;
      charEnd: number;
      anchor: { kind: string; startMs?: number };
    };

export const api = {
  settings: () => call<Settings>("/settings"),
  saveSettings: (u: SettingsUpdate) =>
    call<Settings>("/settings", { method: "PUT", body: JSON.stringify(u) }),
  saveSecret: (name: string, value: string) =>
    call<{ stored: boolean }>(`/secrets/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ value }),
    }),
  usage: () => call<Usage>("/usage"),
  hardware: () => call<Hardware>("/system/hardware"),
  anchor: (documentId: string, chunkId: string) =>
    call<AnchorView>(
      `/documents/${encodeURIComponent(documentId)}/anchor?chunk=${encodeURIComponent(chunkId)}`,
    ),
  actions: (status?: ActionStatus) =>
    call<{ actions: ActionRecord[] }>(`/actions${status ? `?status=${status}` : ""}`),
  editAction: (id: string, payload: unknown) =>
    call<ActionRecord>(`/actions/${id}`, { method: "PATCH", body: JSON.stringify({ payload }) }),
  /** holdMs: the Undo window before the daemon runs it (10 s by default; 0 = "Run now"). */
  approveAction: (id: string, payloadHash: string, acknowledgeSources = false, holdMs?: number) =>
    call<ActionRecord>(`/actions/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        payloadHash,
        ...(acknowledgeSources ? { acknowledgeSources } : {}),
        ...(holdMs === undefined ? {} : { holdMs }),
      }),
    }),
  /** Undo during the hold: the action goes back to a draft. */
  revokeAction: (id: string) => call<ActionRecord>(`/actions/${id}/revoke`, { method: "POST" }),
  rules: () => call<{ rules: ActionRule[] }>("/rules"),
  previewRule: (r: RuleCreate) =>
    call<RulePreview>("/rules/preview", { method: "POST", body: JSON.stringify(r) }),
  createRule: (r: RuleCreate) =>
    call<ActionRule>("/rules", { method: "POST", body: JSON.stringify(r) }),
  revokeRule: (id: string) => call<ActionRule>(`/rules/${id}/revoke`, { method: "POST" }),
  executeAction: (id: string) => call<ActionRecord>(`/actions/${id}/execute`, { method: "POST" }),
  rejectAction: (id: string, note?: string) =>
    call<ActionRecord>(`/actions/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {}),
    }),
  cloneAction: (id: string) => call<ActionRecord>(`/actions/${id}/clone`, { method: "POST" }),
  audit: (cursor?: number) =>
    call<{ entries: AuditRow[]; nextCursor: number | null }>(
      `/audit${cursor ? `?cursor=${cursor}` : ""}`,
    ),
  verifyAudit: () => call<AuditVerify>("/audit/verify", { method: "POST" }),
  deleteEverything: () =>
    call<{ deleting: string }>("/deletion", {
      method: "POST",
      body: JSON.stringify({ target: { everything: true }, confirm: "DELETE" }),
    }),
  // --- Meetings (Phase 3) ---
  startRecording: (input: RecordingStart) =>
    call<{ id: string }>("/recordings", { method: "POST", body: JSON.stringify(input) }),
  putChunk: (id: string, channel: "mic" | "system", n: number, bytes: Uint8Array) =>
    putBytes(`/recordings/${id}/chunks/${n}?channel=${channel}`, bytes),
  stopRecording: (id: string) =>
    call<{ jobId: string }>(`/recordings/${id}/stop`, { method: "POST" }),
  activeRecordings: () =>
    call<{ recordings: { id: string; title: string; startedAt: number }[] }>("/recordings/active"),
  meetings: () => call<{ meetings: Meeting[] }>("/meetings"),
  meeting: (id: string) => call<MeetingDetail>(`/meetings/${encodeURIComponent(id)}`),
  retryMeeting: (id: string) =>
    call<{ jobId: string }>(`/meetings/${id}/retry`, { method: "POST" }),
  deleteMeeting: (id: string) => call<unknown>(`/meetings/${id}`, { method: "DELETE" }),
  commitments: (f: { status?: CommitmentStatus | undefined; owner?: string | undefined } = {}) => {
    const q = new URLSearchParams();
    if (f.status) q.set("status", f.status);
    if (f.owner) q.set("owner", f.owner);
    return call<{ commitments: Commitment[] }>(`/commitments${q.size ? `?${q}` : ""}`);
  },
  patchCommitment: (id: string, patch: CommitmentPatch) =>
    call<Commitment>(`/commitments/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  decisions: (q = "") =>
    call<{ decisions: Decision[] }>(`/decisions${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  entities: (q = "") =>
    call<{ entities: Entity[] }>(`/entities${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  // --- Connectors (Phase 4) ---
  connectors: () => call<{ connectors: Connector[] }>("/connectors"),
  catalog: () => call<{ catalog: ConnectorCatalogEntry[] }>("/connectors/catalog"),
  recentEvents: (n = 500) => call<EventsPage>(`/events/page?tail=${n}`),
  eventsPage: (after = 0, opts: { runId?: string; limit?: number } = {}) =>
    call<EventsPage>(
      `/events/page?after=${after}${opts.runId ? `&runId=${encodeURIComponent(opts.runId)}` : ""}${opts.limit ? `&limit=${opts.limit}` : ""}`,
    ),
  addConnector: (kind: string, config: Record<string, unknown>) =>
    call<Connector>("/connectors", { method: "POST", body: JSON.stringify({ kind, config }) }),
  updateConnector: (id: string, patch: ConnectorUpdate) =>
    call<Connector>(`/connectors/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeConnector: (id: string, purge: boolean) =>
    call<{ purged: number }>(`/connectors/${id}${purge ? "?purge=1" : ""}`, { method: "DELETE" }),
  setConnectorSecret: (id: string, name: string, value: string) =>
    call<{ stored: boolean }>(`/connectors/${id}/secrets/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ value }),
    }),
  setOAuthClient: (group: string, json: string) =>
    call<{ stored: boolean }>(`/connectors/oauth/${encodeURIComponent(group)}/client`, {
      method: "POST",
      body: JSON.stringify({ json }),
    }),
  startAuth: (id: string) =>
    call<{ authUrl: string }>(`/connectors/${id}/auth`, { method: "POST" }),
  testConnector: (id: string) =>
    call<ConnectorHealth>(`/connectors/${id}/test`, { method: "POST" }),
  syncConnector: (id: string) =>
    call<{ started: boolean }>(`/connectors/${id}/sync`, { method: "POST" }),
  connectorRuns: (id: string) => call<{ runs: ConnectorRun[] }>(`/connectors/${id}/runs`),
  archiveImports: () => call<{ imports: ArchiveImportRow[] }>("/imports/archives"),
  deleteArchiveImport: (format: string, archive: string) =>
    call<{ documents: number }>(
      `/imports/archives/${format}?archive=${encodeURIComponent(archive)}`,
      { method: "DELETE" },
    ),
  proposeAction: (type: string, payload: unknown, citations: Citation[]) =>
    call<ActionRecord>("/actions", {
      method: "POST",
      body: JSON.stringify({ type, payload, citations }),
    }),
  ingest: (path: string) =>
    call<{ results: { status: string; path: string; reason?: string }[] }>("/ingest", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  // --- Notebooks and study (Phase 5) ---
  notebooks: () => call<{ notebooks: Notebook[] }>("/notebooks"),
  notebook: (id: string) => call<Notebook>(`/notebooks/${encodeURIComponent(id)}`),
  createNotebook: (input: NotebookCreate) =>
    call<Notebook>("/notebooks", { method: "POST", body: JSON.stringify(input) }),
  updateNotebook: (id: string, patch: NotebookUpdate) =>
    call<Notebook>(`/notebooks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteNotebook: (id: string, withSources: boolean) =>
    call<unknown>(`/notebooks/${id}${withSources ? "?withSources=1" : ""}`, { method: "DELETE" }),
  notebookSources: (id: string) =>
    call<{ sources: NotebookSource[] }>(`/notebooks/${encodeURIComponent(id)}/sources`),
  addSource: (id: string, docId: string) =>
    call<Notebook>(`/notebooks/${id}/sources/${encodeURIComponent(docId)}`, { method: "POST" }),
  removeSource: (id: string, docId: string) =>
    call<Notebook>(`/notebooks/${id}/sources/${encodeURIComponent(docId)}`, { method: "DELETE" }),
  previewScope: (rules: ScopeRules) =>
    call<{ count: number; sample: { id: string; title: string }[] }>("/notebooks/scope/preview", {
      method: "POST",
      body: JSON.stringify(rules),
    }),
  studyJob: (id: string, task: StudyTask) =>
    call<{ jobId: string }>(`/notebooks/${id}/jobs/${task}`, { method: "POST" }),
  studyGuide: (id: string) =>
    call<{ guide: StudyGuide | null }>(`/notebooks/${encodeURIComponent(id)}/guide`),
  mindMap: (id: string) =>
    call<{ mindmap: MindMap | null }>(`/notebooks/${encodeURIComponent(id)}/mindmap`),
  countdown: (id: string) => call<Countdown>(`/notebooks/${encodeURIComponent(id)}/countdown`),
  workload: (id: string) =>
    call<{ items: WorkloadItem[] }>(`/notebooks/${encodeURIComponent(id)}/workload`),
  cards: (id: string) => call<{ cards: Card[] }>(`/notebooks/${encodeURIComponent(id)}/cards`),
  /** Direct download link; the daemon sets content-disposition. */
  exportUrl: (id: string, format: "anki" | "md") =>
    `/api/v1/notebooks/${encodeURIComponent(id)}/export?format=${format}`,
  reviewQueue: (notebookId?: string) =>
    call<ReviewQueue>(
      `/study/review${notebookId ? `?notebook=${encodeURIComponent(notebookId)}` : ""}`,
    ),
  reviewCard: (id: string, rating: Rating) =>
    call<Card>(`/cards/${id}/review`, { method: "POST", body: JSON.stringify({ rating }) }),
  updateCard: (id: string, patch: { front?: string; back?: string; suspended?: boolean }) =>
    call<Card>(`/cards/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteCard: (id: string) => call<{ deleted: boolean }>(`/cards/${id}`, { method: "DELETE" }),
  createQuiz: (input: QuizCreate) =>
    call<{ id: string }>("/quizzes", { method: "POST", body: JSON.stringify(input) }),
  nextQuestion: (quizId: string) =>
    call<QuizQuestion>(`/quizzes/${quizId}/next`, { method: "POST" }),
  answerQuestion: (quizId: string, questionId: string, answer: string) =>
    call<QuizGrade>(`/quizzes/${quizId}/answer`, {
      method: "POST",
      body: JSON.stringify({ questionId, answer }),
    }),
};

/**
 * POST /ask as SSE. EventSource can't POST, so the stream is read with fetch and parsed here.
 * Resolves with the final result; an `error` event rejects with an ApiError.
 */
export async function askStream(
  req: AskRequest,
  onEvent: (e: AskEvent) => void,
  signal?: AbortSignal,
): Promise<AskResult> {
  const res = await fetch("/api/v1/ask", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(res.status, body.code ?? `HTTP_${res.status}`, body.error ?? res.statusText);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let result: AskResult | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let sep = buf.indexOf("\n\n");
    while (sep !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      sep = buf.indexOf("\n\n");
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const payload = JSON.parse(data) as Record<string, unknown>;
      if (event === "error") {
        throw new ApiError(
          500,
          String(payload.code ?? "INTERNAL"),
          String(payload.error ?? "Ask failed"),
        );
      }
      const e = { type: event, ...payload } as AskEvent;
      if (e.type === "done") result = e.result;
      onEvent(e);
    }
  }
  if (!result) throw new ApiError(500, "STREAM_ENDED", "The answer stream ended early.");
  return result;
}

/**
 * POST with an SSE reply (briefs, drafts): progress events go to `onEvent`; resolves with the
 * `done` event's result, rejects with the `error` event as an ApiError.
 */
export async function postStream<T>(
  path: string,
  body: unknown,
  onEvent: (e: { type: string; [k: string]: unknown }) => void = () => {},
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) throw await toError(res);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let sep = buf.indexOf("\n\n");
    while (sep !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      sep = buf.indexOf("\n\n");
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const payload = JSON.parse(data) as Record<string, unknown>;
      if (event === "error")
        throw new ApiError(
          500,
          String(payload.code ?? "INTERNAL"),
          String(payload.error ?? "Failed"),
        );
      if (event === "done") return payload.result as T;
      onEvent({ type: event, ...payload });
    }
  }
  throw new ApiError(500, "STREAM_ENDED", "The stream ended early.");
}

// --- Assistant layer (Phase 6) ---
export const assistant = {
  home: () => call<HomeSummary>("/home"),
  timeline: (from: number, to: number) =>
    call<{ items: TimelineItem[] }>(`/timeline?from=${from}&to=${to}`),
  brief: (req: BriefRequest, onEvent?: (e: { type: string }) => void) =>
    postStream<Brief>("/briefs", req, onEvent),
  latestBrief: (kind: "event" | "notebook", subject: string) =>
    call<{ brief: Brief | null }>(
      `/briefs/latest?kind=${kind}&subject=${encodeURIComponent(subject)}`,
    ),
  routines: () => call<{ routines: Routine[] }>("/routines"),
  routine: (id: string) => call<Routine>(`/routines/${encodeURIComponent(id)}`),
  createRoutine: (input: RoutineCreate) =>
    call<Routine>("/routines", { method: "POST", body: JSON.stringify(input) }),
  addFromTemplate: (pack: string, template?: string) =>
    call<{ added: number; routines: Routine[] }>("/routines/from-template", {
      method: "POST",
      body: JSON.stringify({ pack, ...(template ? { template } : {}) }),
    }),
  updateRoutine: (id: string, patch: RoutineUpdate) =>
    call<Routine>(`/routines/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRoutine: (id: string) =>
    call<{ deleted: boolean }>(`/routines/${id}`, { method: "DELETE" }),
  runRoutine: (id: string) => call<{ jobId: string }>(`/routines/${id}/run`, { method: "POST" }),
  runs: (id: string) => call<{ runs: RoutineRun[] }>(`/routines/${encodeURIComponent(id)}/runs`),
  templates: () =>
    call<{
      packs: {
        id: string;
        name: string;
        description: string;
        routines: { template: string; name: string; schedule: string }[];
      }[];
    }>("/templates"),
  draft: (req: DraftRequest, onEvent?: (e: { type: string; text?: unknown }) => void) =>
    postStream<ActionRecord>("/drafts", req, onEvent),
  propose: (documentId: string, instruction: string) =>
    call<{ proposed: ActionRecord[]; dropped: { type: string; reason: string }[] }>("/proposals", {
      method: "POST",
      body: JSON.stringify({ documentId, instruction }),
    }),
  style: () =>
    call<{ profile: { descriptor: string; exemplars: string[]; updatedAt: number } | null }>(
      "/style",
    ),
  refreshStyle: () => call<{ jobId: string }>("/style/refresh", { method: "POST" }),
  sourcePack: (notebookId: string) =>
    call<ActionRecord>(`/notebooks/${notebookId}/source-pack`, { method: "POST" }),
};

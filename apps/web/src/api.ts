import type {
  ActionRecord,
  ActionStatus,
  AskEvent,
  AskRequest,
  AskResult,
  AuditRow,
  AuditVerify,
  Citation,
  Commitment,
  CommitmentPatch,
  CommitmentStatus,
  Connector,
  ConnectorCatalogEntry,
  ConnectorHealth,
  ConnectorRun,
  ConnectorUpdate,
  Decision,
  Entity,
  Hardware,
  JobEvent,
  Meeting,
  MeetingDetail,
  MeetingKind,
  RecordingStart,
  SettingsUpdate,
  TranscriptSegment,
} from "@rocky/contracts";

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
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = new URLSearchParams({ filename: file.name, kind: opts.kind });
    xhr.open("POST", `/api/v1/imports/media?${q}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      const body = JSON.parse(xhr.responseText || "{}") as {
        meetingId?: string;
        jobId?: string;
        error?: string;
        code?: string;
      };
      if (xhr.status >= 200 && xhr.status < 300)
        resolve({ meetingId: body.meetingId as string, jobId: body.jobId as string });
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
  approveAction: (id: string, payloadHash: string) =>
    call<ActionRecord>(`/actions/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ payloadHash }),
    }),
  executeAction: (id: string) => call<ActionRecord>(`/actions/${id}/execute`, { method: "POST" }),
  rejectAction: (id: string) => call<ActionRecord>(`/actions/${id}/reject`, { method: "POST" }),
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

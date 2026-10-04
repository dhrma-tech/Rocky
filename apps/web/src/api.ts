import type { AskEvent, AskRequest, AskResult, Hardware, SettingsUpdate } from "@rocky/contracts";

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

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(res.status, body.code ?? `HTTP_${res.status}`, body.error ?? res.statusText);
  }
  return (await res.json()) as T;
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

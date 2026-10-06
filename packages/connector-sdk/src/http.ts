import type { Logger } from "./types.ts";

/**
 * Rate-limit aware fetch for connectors (CONNECTORS.md): retries 429, 5xx and secondary-limit 403s,
 * honors Retry-After (seconds or HTTP date) and Notion's body `retry_after`, waits for
 * `x-ratelimit-reset` when the quota is spent, otherwise backs off exponentially with full jitter.
 * At most `maxAttempts` tries, then the last response is returned for the caller to raise.
 */

export interface HttpOptions {
  fetch?: typeof fetch;
  maxAttempts?: number;
  /** Concurrent requests per connector. */
  concurrency?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  log?: Logger;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface Http {
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  /** JSON request; throws HttpError on a non-2xx final response. */
  json<T>(url: string | URL, init?: RequestInit): Promise<T>;
  /** Requests made, including retries (sync logs and delta tests). */
  readonly requests: number;
}

export class HttpError extends Error {
  readonly code = "HTTP_ERROR";
  readonly status: number;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(
      `HTTP ${status} from ${new URL(url).host}${new URL(url).pathname}: ${body.slice(0, 300)}`,
    );
    this.status = status;
    this.body = body;
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Delay requested by the server, in ms, or null when it gave none. */
export async function serverDelayMs(res: Response, now = Date.now()): Promise<number | null> {
  const ra = res.headers.get("retry-after");
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra.trim())) return Number(ra) * 1000;
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  // GitHub: primary quota spent → wait for the reset time.
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (reset) return Math.max(0, reset * 1000 - now);
  }
  // Notion (2026-09): the wait is also in the body.
  if (res.status === 429 && res.headers.get("content-type")?.includes("json")) {
    try {
      const body = (await res.clone().json()) as { additional_data?: { retry_after?: number } };
      const s = body.additional_data?.retry_after;
      if (typeof s === "number") return s * 1000;
    } catch {
      // Not JSON after all.
    }
  }
  return null;
}

const retryable = (res: Response) =>
  res.status === 429 ||
  res.status >= 500 ||
  // GitHub secondary rate limits arrive as 403 with retry-after or a spent quota.
  (res.status === 403 &&
    (res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0"));

export function createHttp(opts: HttpOptions = {}): Http {
  const doFetch = opts.fetch ?? fetch;
  const max = opts.maxAttempts ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const limit = Math.max(1, opts.concurrency ?? 4);
  let active = 0;
  const waiting: (() => void)[] = [];
  let requests = 0;

  const acquire = async () => {
    if (active >= limit) await new Promise<void>((r) => waiting.push(r));
    active++;
  };
  const release = () => {
    active--;
    waiting.shift()?.();
  };

  const http: Http = {
    get requests() {
      return requests;
    },
    async fetch(url, init = {}) {
      for (let attempt = 1; ; attempt++) {
        await acquire();
        let res: Response;
        try {
          requests++;
          res = await doFetch(url, init);
        } catch (err) {
          release();
          // Network errors retry like 5xx, unless cancelled.
          if (init.signal?.aborted || attempt >= max) throw err;
          await sleep(
            Math.min(cap, base * 2 ** (attempt - 1)) * random(),
            init.signal ?? undefined,
          );
          continue;
        }
        release();
        if (!retryable(res) || attempt >= max) return res;
        const server = await serverDelayMs(res, now());
        // Full jitter when the server says nothing; the server's delay is honored exactly.
        const delay = server ?? Math.min(cap, base * 2 ** (attempt - 1)) * random();
        opts.log?.(
          `HTTP ${res.status} from ${new URL(String(url)).host}; retry ${attempt}/${max - 1} in ${Math.round(delay)} ms`,
        );
        await res.body?.cancel();
        await sleep(delay, init.signal ?? undefined);
      }
    },
    async json<T>(url: string | URL, init?: RequestInit) {
      const res = await http.fetch(url, init);
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, String(url), text);
      return (text ? JSON.parse(text) : {}) as T;
    },
  };
  return http;
}

/** `Link: <url>; rel="next"` → the next URL (GitHub pagination). */
export function nextLink(res: Response): string | null {
  const link = res.headers.get("link");
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m?.[1]) return m[1];
  }
  return null;
}

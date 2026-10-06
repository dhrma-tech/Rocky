import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AuthExpired } from "./types.ts";

/**
 * OAuth for installed apps (Google): loopback redirect on 127.0.0.1 with PKCE S256 and a random
 * state. The browser is opened by the caller (the web UI), so this returns the URL and a promise.
 * Verified 2026-10-06 against developers.google.com/identity/protocols/oauth2/native-app.
 */

export interface LoopbackOptions {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  authUrl: string;
  tokenUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra auth URL params; defaults request a refresh token and incremental scopes. */
  extraParams?: Record<string, string>;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

export interface LoopbackSession {
  authUrl: string;
  /** Resolves with the tokens once the browser comes back; rejects on error, denial or timeout. */
  done: Promise<TokenResponse>;
  close(): void;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Rocky</title><body style="font-family:system-ui;padding:2rem">${msg}</body>`;

export async function startLoopbackAuth(opts: LoopbackOptions): Promise<LoopbackSession> {
  const doFetch = opts.fetch ?? fetch;
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));
  let settle: { resolve(t: TokenResponse): void; reject(e: Error): void } | undefined;
  const done = new Promise<TokenResponse>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The promise may be awaited later (or never, if the user walks away); avoid unhandled rejections.
  done.catch(() => {});

  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const timer = setTimeout(() => {
    settle?.reject(new Error("Sign-in timed out after 5 minutes. Start it again."));
    close();
  }, opts.timeoutMs ?? 300_000);
  const close = () => {
    clearTimeout(timer);
    server.close();
  };

  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    const finish = (status: number, msg: string) =>
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(PAGE(msg));
    if (url.searchParams.get("state") !== state) {
      finish(400, "This sign-in link is not the one Rocky started. Close this tab and try again.");
      return; // A stray or forged request must not end the real flow.
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    try {
      if (error || !code)
        throw new Error(`Google sign-in was not completed (${error ?? "no code"}).`);
      const r = await doFetch(opts.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });
      const body = (await r.json()) as TokenResponse & {
        error?: string;
        error_description?: string;
      };
      if (!r.ok || body.error)
        throw new Error(
          `Token exchange failed: ${body.error_description ?? body.error ?? r.status}`,
        );
      finish(200, "Rocky is connected. You can close this tab.");
      settle?.resolve(body);
    } catch (err) {
      finish(400, `Sign-in failed. ${err instanceof Error ? err.message : String(err)}`);
      settle?.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      close();
    }
  });

  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: opts.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    ...opts.extraParams,
  });
  return { authUrl: `${opts.authUrl}?${params}`, done, close };
}

/** Exchanges a refresh token for an access token; `invalid_grant` means the user must sign in again. */
export async function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl: string;
  fetch?: typeof fetch;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const r = await (opts.fetch ?? fetch)(opts.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await r.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (body.error === "invalid_grant")
    throw new AuthExpired(
      "Google sign-in expired or was revoked. Reconnect Google on the Connectors page.",
    );
  if (!r.ok || !body.access_token)
    throw new Error(`Token refresh failed: ${body.error_description ?? body.error ?? r.status}`);
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

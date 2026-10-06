import {
  type AnchorUnit,
  AuthExpired,
  type Connector,
  type ConnectorAction,
  type Http,
  HttpError,
  nextLink,
  type SourceDocument,
} from "@rocky/connector-sdk";
import { z } from "zod";

/**
 * GitHub (CONNECTORS.md #5). Fine-grained PAT: Metadata R, Contents R, Issues RW, Pull requests R.
 * Verified 2026-10-06: API version 2026-03-10; issues list includes PRs (`pull_request` key);
 * `since` = updated at or after; pagination via the Link header; create issue takes title, body,
 * labels, assignees[] (the singular `assignee` is gone in 2026-03-10).
 */

const API = "https://api.github.com";
const VERSION = "2026-03-10";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const GithubConfigSchema = z.object({
  repos: z.array(z.string().regex(REPO_RE, "repos look like owner/name")).min(1).max(50),
  backfillDays: z.number().int().min(1).max(3650).optional(),
});
export type GithubConfig = z.infer<typeof GithubConfigSchema>;

/** Per repo: the highest `updated_at` seen (ISO). `since` is inclusive, so the edge item repeats harmlessly. */
export type GithubCursor = Record<string, string>;

interface GhUser {
  login: string;
}
interface GhIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: GhUser | null;
  labels: ({ name: string } | string)[];
  comments: number;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}
interface GhComment {
  id: number;
  body: string | null;
  user: GhUser | null;
  html_url: string;
  created_at: string;
}

const headers = (token: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": VERSION,
});

function token(secrets: { get(n: string): string | null }): string {
  const t = secrets.get("token");
  if (!t) throw new AuthExpired("Add a GitHub token on the Connectors page.");
  return t;
}

async function getJson<T>(
  http: Http,
  url: string,
  tok: string,
): Promise<{ data: T; next: string | null; res: Response }> {
  const res = await http.fetch(url, { headers: headers(tok) });
  const text = await res.text();
  if (res.status === 401)
    throw new AuthExpired("GitHub rejected the token (expired or revoked). Add a new one.");
  if (!res.ok) throw new HttpError(res.status, url, text);
  return { data: JSON.parse(text) as T, next: nextLink(res), res };
}

async function allComments(http: Http, repo: string, n: number, tok: string): Promise<GhComment[]> {
  const out: GhComment[] = [];
  let url: string | null = `${API}/repos/${repo}/issues/${n}/comments?per_page=100`;
  while (url) {
    const page: { data: GhComment[]; next: string | null } = await getJson<GhComment[]>(
      http,
      url,
      tok,
    );
    out.push(...page.data);
    url = page.next;
  }
  return out;
}

export function issueToDocument(
  repo: string,
  issue: GhIssue,
  comments: GhComment[],
): SourceDocument {
  const isPr = issue.pull_request !== undefined;
  const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name));
  const units: AnchorUnit[] = [
    {
      anchor: { kind: "github", type: isPr ? "pr" : "issue", number: issue.number },
      heading: `${isPr ? "Pull request" : "Issue"} #${issue.number} by ${issue.user?.login ?? "unknown"} (${issue.state}${labels.length ? `; ${labels.join(", ")}` : ""})`,
      text: `${issue.title}\n\n${issue.body ?? ""}`.trim(),
    },
    ...comments.map((c) => ({
      anchor: {
        kind: "github" as const,
        type: "comment" as const,
        number: issue.number,
        commentId: String(c.id),
      },
      heading: `Comment by ${c.user?.login ?? "unknown"} on ${c.created_at.slice(0, 10)}`,
      text: c.body ?? "",
    })),
  ];
  return {
    externalId: `${repo}#${issue.number}`,
    sourceType: "github",
    title: `${repo}#${issue.number}: ${issue.title}`,
    uri: issue.html_url,
    ...(issue.user ? { author: { name: issue.user.login } } : {}),
    createdAt: Date.parse(issue.created_at),
    updatedAt: Date.parse(issue.updated_at),
    mime: "text/markdown",
    body: { kind: "text", units },
    meta: {
      repo,
      number: issue.number,
      kind: isPr ? "pr" : "issue",
      state: issue.state,
      labels,
      commentUrls: Object.fromEntries(comments.map((c) => [String(c.id), c.html_url])),
    },
  };
}

const IssueCreateSchema = z
  .object({
    repo: z.string().regex(REPO_RE),
    title: z.string().trim().min(1).max(256),
    body: z.string().max(60_000).default(""),
    labels: z.array(z.string().min(1).max(50)).max(10).optional(),
  })
  .strict();
type IssueCreate = z.infer<typeof IssueCreateSchema>;

/** Hidden marker for search-before-create (actions.md "Idempotency"). */
export const marker = (key: string) => `<!-- rocky:${key} -->`;

const issueCreate: ConnectorAction<IssueCreate> = {
  type: "github.issueCreate",
  title: "Create GitHub issue",
  schema: IssueCreateSchema,
  risk: "medium",
  describe: (p) => ({
    target: p.repo,
    summary: `New issue "${p.title}"${p.labels?.length ? ` with labels ${p.labels.join(", ")}` : ""}`,
  }),
  async execute(p, ctx) {
    const cfg = GithubConfigSchema.parse(ctx.config);
    if (!cfg.repos.includes(p.repo))
      throw new Error(`${p.repo} is not one of the repositories configured for GitHub`);
    const tok = token(ctx.secrets);
    const mark = marker(ctx.idempotencyKey);
    // A retry after a timeout must not create a second issue: look for our marker first.
    const recent = await getJson<GhIssue[]>(
      ctx.http,
      `${API}/repos/${p.repo}/issues?state=all&sort=created&direction=desc&per_page=50`,
      tok,
    );
    const existing = recent.data.find((i) => i.body?.includes(mark));
    if (existing) return { number: existing.number, url: existing.html_url, reused: true };
    const res = await ctx.http.fetch(`${API}/repos/${p.repo}/issues`, {
      method: "POST",
      headers: { ...headers(tok), "content-type": "application/json" },
      body: JSON.stringify({
        title: p.title,
        body: `${p.body}\n\n${mark}`.trim(),
        ...(p.labels?.length ? { labels: p.labels } : {}),
      }),
      signal: ctx.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, `${API}/repos/${p.repo}/issues`, text);
    const created = JSON.parse(text) as GhIssue;
    return { number: created.number, url: created.html_url };
  },
};

export const github: Connector<GithubConfig, GithubCursor> = {
  id: "github",
  displayName: "GitHub",
  permissions: "Reads issues and pull requests; creates issues after approval",
  configSchema: GithubConfigSchema,
  secrets: [
    {
      name: "token",
      label: "fine-grained access token",
      description:
        "Permissions: Metadata read, Contents read, Issues read and write, Pull requests read.",
    },
  ],
  defaultIntervalMin: 15,
  async *sync(ctx, cursor) {
    const tok = token(ctx.secrets);
    const next: GithubCursor = { ...cursor };
    for (const repo of ctx.config.repos) {
      const since = next[repo] ?? new Date(ctx.since).toISOString();
      let url: string | null =
        `${API}/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`;
      while (url) {
        const page: { data: GhIssue[]; next: string | null } = await getJson<GhIssue[]>(
          ctx.http,
          url,
          tok,
        );
        const documents: SourceDocument[] = [];
        for (const issue of page.data) {
          const comments =
            issue.comments > 0 ? await allComments(ctx.http, repo, issue.number, tok) : [];
          documents.push(issueToDocument(repo, issue, comments));
          if (!next[repo] || issue.updated_at > next[repo]) next[repo] = issue.updated_at;
        }
        yield { documents, cursor: { ...next } };
        url = page.next;
      }
    }
  },
  async health(ctx) {
    const tok = token(ctx.secrets);
    const me = await getJson<GhUser>(ctx.http, `${API}/user`, tok);
    // Fine-grained PATs expire (max 366 days); warn two weeks ahead. Header format: "2026-12-31 00:00:00 UTC".
    const exp = me.res.headers.get("github-authentication-token-expiration");
    const expiresAt = exp ? Date.parse(exp.replace(" UTC", "Z").replace(" ", "T")) : Number.NaN;
    const missing: string[] = [];
    for (const repo of ctx.config.repos) {
      const r = await ctx.http.fetch(`${API}/repos/${repo}`, { headers: headers(tok) });
      await r.body?.cancel();
      if (!r.ok) missing.push(repo);
    }
    if (missing.length)
      return {
        status: "degraded",
        message: `No access to ${missing.join(", ")}. Add them to the token.`,
        account: me.data.login,
      };
    if (!Number.isNaN(expiresAt) && expiresAt - Date.now() < 14 * 86_400_000)
      return {
        status: "degraded",
        message: `The token expires on ${new Date(expiresAt).toISOString().slice(0, 10)}. Create a new one.`,
        account: me.data.login,
        tokenExpiresAt: expiresAt,
      };
    return {
      status: "ok",
      message: `Signed in as ${me.data.login}`,
      account: me.data.login,
      ...(Number.isNaN(expiresAt) ? {} : { tokenExpiresAt: expiresAt }),
    };
  },
  actions: () => [issueCreate],
};

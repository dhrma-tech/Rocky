import {
  type AnchorUnit,
  AuthExpired,
  type Connector,
  type ConnectorAction,
  type Http,
  HttpError,
  type SourceDocument,
} from "@rocky/connector-sdk";
import { z } from "zod";

/**
 * Linear (CONNECTORS.md #6). Personal API key. Verified 2026-10-07: POST
 * https://api.linear.app/graphql with `Authorization: <key>` (no Bearer); Relay pagination
 * (first/after, pageInfo); issueCreate {teamId, title, description, dueDate, stateId};
 * issueUpdate {id (uuid or "ENG-123"), …}. Keep `first` small: queries are charged by complexity.
 */

const API = "https://api.linear.app/graphql";
const PAGE = 50;

export const LinearConfigSchema = z.object({
  /** Team keys to sync, e.g. ["ENG"]; empty = every team the key can see. */
  teamKeys: z
    .array(z.string().regex(/^[A-Z0-9]{1,10}$/, "team keys look like ENG"))
    .max(20)
    .default([]),
  backfillDays: z.number().int().min(1).max(3650).optional(),
});
export type LinearConfig = z.infer<typeof LinearConfigSchema>;
/** Highest `updatedAt` seen (ISO). */
export interface LinearCursor {
  updatedAt?: string;
}

interface LIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  state: { name: string; type: string } | null;
  team: { key: string; name: string } | null;
  assignee: { name: string; email?: string | null } | null;
  creator: { name: string; email?: string | null } | null;
  comments: {
    nodes: {
      id: string;
      body: string;
      createdAt: string;
      url: string;
      user: { name: string } | null;
    }[];
  };
}

function key(secrets: { get(n: string): string | null }): string {
  const k = secrets.get("token");
  if (!k) throw new AuthExpired("Add a Linear API key on the Connectors page.");
  return k;
}

/** One GraphQL request; GraphQL errors are thrown with Linear's message. */
export async function gql<T>(
  http: Http,
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const res = await http.fetch(API, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  const body = (text ? JSON.parse(text) : {}) as {
    data?: T;
    errors?: { message: string; extensions?: { code?: string } }[];
  };
  const authError = body.errors?.some((e) => /AUTHENTICATION/i.test(e.extensions?.code ?? ""));
  if (res.status === 401 || authError)
    throw new AuthExpired("Linear rejected the API key. Create a new one in Settings → API.");
  if (!res.ok) throw new HttpError(res.status, API, text);
  if (body.errors?.length)
    throw new Error(`Linear: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data as T;
}

const ISSUE_FIELDS = `id identifier title description url dueDate createdAt updatedAt archivedAt
  state { name type } team { key name } assignee { name email } creator { name email }
  comments(first: 20) { nodes { id body createdAt url user { name } } }`;

const ISSUES = `query Issues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, includeArchived: true) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const closed = (type?: string) => type === "completed" || type === "canceled";

export function issueToDocument(i: LIssue): SourceDocument {
  const units: AnchorUnit[] = [
    {
      anchor: { kind: "row", rowId: i.identifier },
      heading: `${i.identifier} (${i.state?.name ?? "no state"}${i.assignee ? `, ${i.assignee.name}` : ""}${i.dueDate ? `, due ${i.dueDate}` : ""})`,
      text: `${i.title}\n\n${i.description ?? ""}`.trim(),
    },
    ...i.comments.nodes.map((c) => ({
      anchor: { kind: "row" as const, rowId: `${i.identifier}#${c.id}` },
      heading: `Comment by ${c.user?.name ?? "unknown"} on ${c.createdAt.slice(0, 10)}`,
      text: c.body,
    })),
  ];
  return {
    externalId: i.id,
    sourceType: "task",
    title: `${i.identifier}: ${i.title}`,
    uri: i.url,
    ...(i.creator
      ? { author: { name: i.creator.name, ...(i.creator.email ? { email: i.creator.email } : {}) } }
      : {}),
    createdAt: Date.parse(i.createdAt),
    updatedAt: Date.parse(i.updatedAt),
    mime: "text/markdown",
    body: { kind: "text", units },
    meta: {
      identifier: i.identifier,
      state: closed(i.state?.type) ? "closed" : "open",
      status: i.state?.name ?? null,
      ...(i.dueDate ? { dueOn: i.dueDate } : {}),
      project: i.team?.key ?? null,
      assignee: i.assignee?.name ?? null,
      commentUrls: Object.fromEntries(
        i.comments.nodes.map((c) => [`${i.identifier}#${c.id}`, c.url]),
      ),
    },
  };
}

/** Hidden marker for search-before-create (actions.md "Idempotency"). */
export const marker = (k: string) => `<!-- rocky:${k} -->`;

const IssueCreateSchema = z
  .object({
    teamKey: z.string().regex(/^[A-Z0-9]{1,10}$/),
    title: z.string().trim().min(1).max(255),
    description: z.string().max(20_000).default(""),
    dueDate: z.iso.date().optional(),
  })
  .strict();
type IssueCreate = z.infer<typeof IssueCreateSchema>;

const IssueUpdateSchema = z
  .object({
    /** "ENG-123" or the issue uuid. */
    id: z.string().min(1).max(100),
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(20_000).optional(),
    /** Workflow state by name, e.g. "Done". */
    state: z.string().min(1).max(100).optional(),
    dueDate: z.iso.date().nullable().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 1, "change at least one field");
type IssueUpdate = z.infer<typeof IssueUpdateSchema>;

const issueCreate: ConnectorAction<IssueCreate> = {
  type: "linear.issueCreate",
  title: "Create Linear issue",
  schema: IssueCreateSchema,
  risk: "medium",
  describe: (p) => ({
    target: `Linear ${p.teamKey}`,
    summary: `New issue "${p.title}"${p.dueDate ? `, due ${p.dueDate}` : ""}`,
    diff: {
      title: p.title,
      description: p.description,
      ...(p.dueDate ? { dueDate: p.dueDate } : {}),
    },
  }),
  async execute(p, ctx) {
    const k = key(ctx.secrets);
    const mark = marker(ctx.idempotencyKey);
    // A retry after a timeout must not create a second issue: look for our marker first.
    const found = await gql<{ issues: { nodes: { identifier: string; url: string }[] } }>(
      ctx.http,
      k,
      `query Find($m: String!) { issues(first: 1, filter: { description: { contains: $m } }) { nodes { identifier url } } }`,
      { m: mark },
    );
    const existing = found.issues.nodes[0];
    if (existing) return { identifier: existing.identifier, url: existing.url, reused: true };
    const teams = await gql<{ teams: { nodes: { id: string; key: string }[] } }>(
      ctx.http,
      k,
      `query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }`,
      { key: p.teamKey },
    );
    const team = teams.teams.nodes[0];
    if (!team) throw new Error(`No Linear team with key ${p.teamKey}`);
    const r = await gql<{
      issueCreate: { success: boolean; issue: { identifier: string; url: string } | null };
    }>(
      ctx.http,
      k,
      `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }`,
      {
        input: {
          teamId: team.id,
          title: p.title,
          description: `${p.description}\n\n${mark}`.trim(),
          ...(p.dueDate ? { dueDate: p.dueDate } : {}),
        },
      },
      ctx.signal,
    );
    if (!r.issueCreate.success || !r.issueCreate.issue)
      throw new Error("Linear did not create the issue");
    return { identifier: r.issueCreate.issue.identifier, url: r.issueCreate.issue.url };
  },
};

const issueUpdate: ConnectorAction<IssueUpdate> = {
  type: "linear.issueUpdate",
  title: "Update Linear issue",
  schema: IssueUpdateSchema,
  risk: "medium",
  describe: (p) => {
    const { id, ...diff } = p;
    return { target: `Linear ${id}`, summary: `Update ${Object.keys(diff).join(", ")}`, diff };
  },
  async execute(p, ctx) {
    const k = key(ctx.secrets);
    let stateId: string | undefined;
    if (p.state) {
      const s = await gql<{
        issue: { team: { states: { nodes: { id: string; name: string }[] } } };
      }>(
        ctx.http,
        k,
        `query States($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`,
        { id: p.id },
      );
      stateId = s.issue.team.states.nodes.find(
        (x) => x.name.toLowerCase() === p.state?.toLowerCase(),
      )?.id;
      if (!stateId) throw new Error(`No workflow state named "${p.state}" in that issue's team`);
    }
    // An update sets the same fields again on a retry, so it is idempotent as is.
    const r = await gql<{
      issueUpdate: { success: boolean; issue: { identifier: string; url: string } | null };
    }>(
      ctx.http,
      k,
      `mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier url } } }`,
      {
        id: p.id,
        input: {
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(stateId ? { stateId } : {}),
          ...(p.dueDate !== undefined ? { dueDate: p.dueDate } : {}),
        },
      },
      ctx.signal,
    );
    if (!r.issueUpdate.success || !r.issueUpdate.issue)
      throw new Error("Linear did not update the issue");
    return { identifier: r.issueUpdate.issue.identifier, url: r.issueUpdate.issue.url };
  },
};

export const linear: Connector<LinearConfig, LinearCursor> = {
  id: "linear",
  displayName: "Linear",
  permissions: "Reads issues and comments; creates and updates issues after approval",
  configSchema: LinearConfigSchema,
  secrets: [
    {
      name: "token",
      label: "personal API key",
      description: "Linear → Settings → Security & access → Personal API keys → New key.",
    },
  ],
  defaultIntervalMin: 15,
  readOnlyCapable: true,
  async *sync(ctx, cursor) {
    const k = key(ctx.secrets);
    const since = cursor?.updatedAt ?? new Date(ctx.since).toISOString();
    const filter = {
      updatedAt: { gt: since },
      ...(ctx.config.teamKeys.length ? { team: { key: { in: ctx.config.teamKeys } } } : {}),
    };
    let after: string | null = null;
    let max = since;
    do {
      const page: {
        issues: { nodes: LIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      } = await gql(ctx.http, k, ISSUES, { first: PAGE, after, filter }, ctx.signal);
      const documents: SourceDocument[] = [];
      const deleted: string[] = [];
      for (const i of page.issues.nodes) {
        if (i.updatedAt > max) max = i.updatedAt;
        if (i.archivedAt) deleted.push(i.id);
        else documents.push(issueToDocument(i));
      }
      after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
      // Pages aren't in updatedAt order, so the cursor moves only after the last page.
      yield {
        documents,
        ...(deleted.length ? { deletedExternalIds: deleted } : {}),
        cursor: after ? (cursor ?? {}) : { updatedAt: max },
      };
    } while (after);
  },
  async health(ctx) {
    const v = await gql<{ viewer: { name: string }; organization: { name: string } }>(
      ctx.http,
      key(ctx.secrets),
      "query { viewer { name } organization { name } }",
    );
    return {
      status: "ok",
      message: `Signed in as ${v.viewer.name} (${v.organization.name})`,
      account: v.viewer.name,
    };
  },
  actions: () => [issueCreate, issueUpdate],
};

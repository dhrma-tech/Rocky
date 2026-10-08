import {
  AuthExpired,
  type Connector,
  type ConnectorAction,
  type Http,
  HttpError,
  type SourceDocument,
} from "@rocky/connector-sdk";
import { z } from "zod";

/**
 * Asana (CONNECTORS.md #10). Personal access token. Verified 2026-10-07:
 * GET /api/1.0/tasks?project=|workspace=&assignee=me, modified_since, opt_fields, limit ≤ 100,
 * offset pagination via next_page; POST /tasks and PUT /tasks/{gid} with a {data: …} body.
 * 150 req/min on free plans (429 + Retry-After). Deleted tasks are not reported by this endpoint
 * (the events API would need per-resource sync tokens), so they stay until removed by hand.
 */

const API = "https://app.asana.com/api/1.0";
const FIELDS =
  "name,notes,due_on,due_at,completed,assignee.name,permalink_url,created_at,modified_at,projects.name";
const GID = z.string().regex(/^\d{1,30}$/, "Asana ids are numbers (the gid in the project URL)");

export const AsanaConfigSchema = z
  .object({
    /** Project gids to sync. */
    projects: z.array(GID).max(50).default([]),
    /** Also sync tasks assigned to me in this workspace (gid). */
    workspace: GID.optional(),
    backfillDays: z.number().int().min(1).max(3650).optional(),
  })
  .refine((c) => c.projects.length > 0 || c.workspace, "add at least one project or a workspace");
export type AsanaConfig = z.infer<typeof AsanaConfigSchema>;
/** Per source ("project:<gid>" or "me:<workspace>"): the highest modified_at seen. */
export type AsanaCursor = Record<string, string>;

interface ATask {
  gid: string;
  name: string;
  notes?: string;
  due_on?: string | null;
  due_at?: string | null;
  completed?: boolean;
  assignee?: { name: string } | null;
  permalink_url?: string;
  created_at?: string;
  modified_at: string;
  projects?: { name: string }[];
}

function token(secrets: { get(n: string): string | null }): string {
  const t = secrets.get("token");
  if (!t) throw new AuthExpired("Add an Asana personal access token on the Connectors page.");
  return t;
}

async function call<T>(
  http: Http,
  tok: string,
  path: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown; signal?: AbortSignal } = {},
): Promise<{ data: T; next_page?: { offset: string } | null }> {
  const url = `${API}${path}`;
  const res = await http.fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${tok}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    ...(init.body !== undefined ? { body: JSON.stringify({ data: init.body }) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const text = await res.text();
  if (res.status === 401)
    throw new AuthExpired("Asana rejected the token. Create a new personal access token.");
  if (!res.ok) throw new HttpError(res.status, url, text);
  return JSON.parse(text) as { data: T; next_page?: { offset: string } | null };
}

export function taskToDocument(t: ATask): SourceDocument {
  const due = t.due_at ?? t.due_on ?? null;
  const project = t.projects?.[0]?.name ?? null;
  return {
    externalId: t.gid,
    sourceType: "task",
    title: t.name || "(untitled task)",
    ...(t.permalink_url ? { uri: t.permalink_url } : {}),
    createdAt: Date.parse(t.created_at ?? t.modified_at),
    updatedAt: Date.parse(t.modified_at),
    mime: "text/plain",
    body: {
      kind: "text",
      units: [
        {
          anchor: { kind: "row", rowId: t.gid },
          heading: `Asana task${project ? ` in ${project}` : ""}${t.assignee ? `, ${t.assignee.name}` : ""}${due ? `, due ${due}` : ""}${t.completed ? " (done)" : ""}`,
          text: `${t.name}\n\n${t.notes ?? ""}`.trim(),
        },
      ],
    },
    meta: {
      state: t.completed ? "closed" : "open",
      ...(due ? { dueOn: due } : {}),
      project,
      assignee: t.assignee?.name ?? null,
    },
  };
}

const TaskCreateSchema = z
  .object({
    project: GID,
    name: z.string().trim().min(1).max(500),
    notes: z.string().max(20_000).default(""),
    due_on: z.iso.date().optional(),
  })
  .strict();
type TaskCreate = z.infer<typeof TaskCreateSchema>;
const TaskUpdateSchema = z
  .object({
    gid: GID,
    name: z.string().trim().min(1).max(500).optional(),
    notes: z.string().max(20_000).optional(),
    due_on: z.iso.date().nullable().optional(),
    completed: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 1, "change at least one field");
type TaskUpdate = z.infer<typeof TaskUpdateSchema>;

/** Asana has no idempotency keys: a task with the same name in the project, made in the last 10 minutes, is the earlier try. */
const REUSE_MS = 10 * 60_000;

const taskCreate: ConnectorAction<TaskCreate> = {
  type: "asana.taskCreate",
  title: "Create Asana task",
  schema: TaskCreateSchema,
  risk: "low",
  describe: (p) => ({
    target: `Asana project ${p.project}`,
    summary: `New task "${p.name}"${p.due_on ? `, due ${p.due_on}` : ""}`,
    diff: p,
  }),
  async execute(p, ctx) {
    const tok = token(ctx.secrets);
    const recent = await call<
      { gid: string; name: string; created_at: string; permalink_url?: string }[]
    >(
      ctx.http,
      tok,
      `/tasks?project=${p.project}&modified_since=${encodeURIComponent(new Date(Date.now() - REUSE_MS).toISOString())}&opt_fields=name,created_at,permalink_url&limit=100`,
    );
    const dup = recent.data.find(
      (t) => t.name === p.name && Date.now() - Date.parse(t.created_at) < REUSE_MS,
    );
    if (dup) return { gid: dup.gid, url: dup.permalink_url ?? null, reused: true };
    const r = await call<{ gid: string; permalink_url?: string }>(
      ctx.http,
      tok,
      "/tasks?opt_fields=permalink_url",
      {
        method: "POST",
        body: {
          name: p.name,
          notes: p.notes,
          projects: [p.project],
          ...(p.due_on ? { due_on: p.due_on } : {}),
        },
        signal: ctx.signal,
      },
    );
    return { gid: r.data.gid, url: r.data.permalink_url ?? null };
  },
};

const taskUpdate: ConnectorAction<TaskUpdate> = {
  type: "asana.taskUpdate",
  title: "Update Asana task",
  schema: TaskUpdateSchema,
  risk: "low",
  describe: (p) => {
    const { gid, ...diff } = p;
    return { target: `Asana task ${gid}`, summary: `Update ${Object.keys(diff).join(", ")}`, diff };
  },
  async execute(p, ctx) {
    const { gid, ...fields } = p;
    const r = await call<{ gid: string; permalink_url?: string }>(
      ctx.http,
      token(ctx.secrets),
      `/tasks/${gid}?opt_fields=permalink_url`,
      {
        method: "PUT",
        body: fields,
        signal: ctx.signal,
      },
    );
    return { gid: r.data.gid, url: r.data.permalink_url ?? null };
  },
};

export const asana: Connector<AsanaConfig, AsanaCursor> = {
  id: "asana",
  tier: "experimental",
  egress: () => ["app.asana.com"],
  displayName: "Asana",
  permissions:
    "Reads tasks in chosen projects (or assigned to you); creates and updates tasks after approval",
  configSchema: AsanaConfigSchema,
  secrets: [
    {
      name: "token",
      label: "personal access token",
      description:
        "app.asana.com/0/my-apps → Create new token. Project ids are the numbers in project URLs.",
    },
  ],
  defaultIntervalMin: 15,
  readOnlyCapable: true,
  async *sync(ctx, cursor) {
    const tok = token(ctx.secrets);
    const sources = [
      ...ctx.config.projects.map((g) => ({ key: `project:${g}`, query: `project=${g}` })),
      ...(ctx.config.workspace
        ? [
            {
              key: `me:${ctx.config.workspace}`,
              query: `workspace=${ctx.config.workspace}&assignee=me`,
            },
          ]
        : []),
    ];
    const next: AsanaCursor = { ...(cursor ?? {}) };
    for (const s of sources) {
      const since = next[s.key] ?? new Date(ctx.since).toISOString();
      let offset: string | undefined;
      let max = since;
      do {
        const page: { data: ATask[]; next_page?: { offset: string } | null } = await call<ATask[]>(
          ctx.http,
          tok,
          `/tasks?${s.query}&modified_since=${encodeURIComponent(since)}&opt_fields=${FIELDS}&limit=100${offset ? `&offset=${offset}` : ""}`,
        );
        for (const t of page.data) if (t.modified_at > max) max = t.modified_at;
        offset = page.next_page?.offset;
        if (!offset) next[s.key] = max;
        yield { documents: page.data.map(taskToDocument), cursor: { ...next } };
      } while (offset);
    }
  },
  async health(ctx) {
    const me = await call<{ name: string; email?: string }>(
      ctx.http,
      token(ctx.secrets),
      "/users/me",
    );
    return {
      status: "ok",
      message: `Signed in as ${me.data.name}`,
      account: me.data.email ?? me.data.name,
    };
  },
  actions: () => [taskCreate, taskUpdate],
};

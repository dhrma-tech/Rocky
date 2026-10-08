import type { AnchorUnit, Connector, SourceDocument } from "@rocky/connector-sdk";
import { z } from "zod";
import { type GoogleCtx, gjson, googleOAuth, htmlToText, NotFound } from "./common.ts";
import { draftCreate, draftUpdate } from "./gmail-drafts.ts";

/**
 * Gmail read-sync (CONNECTORS.md #1). Verified 2026-10-06:
 * - Full: messages.list q=newer_than:Nd (≤500/page) → unique threads → threads.get format=full.
 * - Incremental: history.list from the stored historyId (messageAdded, messageDeleted); a 404
 *   means the id is too old → full resync. Save historyId from the last page.
 * - Quota (since 2026-05-01): messages.list 5, history.list 2, threads.get 40 units; 6,000/min
 *   per user, so threads are fetched four at a time.
 * Never sends mail: Phase 6 adds drafts only (gmail-drafts.ts); the no-send test scans every package.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const THREADS_PER_BATCH = 20;
const PARALLEL = 4;

export const GmailConfigSchema = z.object({
  backfillDays: z.number().int().min(1).max(3650).default(90),
  /** Extra Gmail search terms for the backfill, e.g. "-category:promotions". */
  query: z.string().max(500).default("-in:spam -in:trash"),
});
export type GmailConfig = z.infer<typeof GmailConfigSchema>;
export interface GmailCursor {
  historyId: string;
}

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number };
  parts?: Part[];
}
interface Message {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate: string;
  historyId: string;
  snippet?: string;
  payload: Part;
}
interface Thread {
  id: string;
  historyId: string;
  messages?: Message[];
}

const header = (m: Message, name: string) =>
  m.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** The readable body: text/plain if present, else text/html as text. Attachments are skipped. */
export function messageText(part: Part): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: Part) => {
    if (p.filename) return; // attachment
    if (p.mimeType === "text/plain" && p.body?.data) plain.push(decode(p.body.data));
    else if (p.mimeType === "text/html" && p.body?.data) html.push(decode(p.body.data));
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  const text = plain.length ? plain.join("\n") : html.map(htmlToText).join("\n");
  return stripQuoted(text);
}

/** Drops the quoted history of a reply ("> …" lines and the "On … wrote:" line before them). */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^\s*>/.test(l)) continue;
    if (/^On .{5,200} wrote:\s*$/.test(l) && /^\s*>/.test(lines[i + 1] ?? lines[i + 2] ?? ""))
      continue;
    out.push(l);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SKIP = new Set(["TRASH", "SPAM"]);

export function threadToDocument(t: Thread): SourceDocument | null {
  const msgs = (t.messages ?? []).filter((m) => !m.labelIds?.some((l) => SKIP.has(l)));
  const first = msgs[0];
  const last = msgs.at(-1);
  if (!first || !last) return null;
  const units: AnchorUnit[] = msgs.map((m) => ({
    anchor: { kind: "message", messageId: m.id, threadId: t.id },
    heading: `From ${header(m, "From")} to ${header(m, "To")} on ${new Date(Number(m.internalDate)).toISOString().slice(0, 16).replace("T", " ")}`,
    text: messageText(m.payload) || m.snippet || "",
  }));
  const from = header(first, "From");
  const email = /<([^>]+)>/.exec(from)?.[1] ?? (from.includes("@") ? from.trim() : undefined);
  const name =
    from
      .replace(/<[^>]+>/, "")
      .replace(/"/g, "")
      .trim() || undefined;
  return {
    externalId: t.id,
    sourceType: "email",
    title: header(first, "Subject") || "(no subject)",
    uri: `https://mail.google.com/mail/u/0/#all/${t.id}`,
    author: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
    createdAt: Number(first.internalDate),
    updatedAt: Number(last.internalDate),
    mime: "message/rfc822",
    body: { kind: "text", units },
    meta: {
      messageCount: msgs.length,
      labels: [...new Set(msgs.flatMap((m) => m.labelIds ?? []))],
      // The user's own messages (style profile samples them, Phase 6).
      sentMessageIds: msgs.filter((m) => m.labelIds?.includes("SENT")).map((m) => m.id),
    },
  };
}

/** Fetches threads a few at a time; a thread that no longer exists is a tombstone. */
async function fetchThreads(
  ctx: GoogleCtx,
  ids: string[],
): Promise<{ docs: SourceDocument[]; gone: string[] }> {
  const docs: SourceDocument[] = [];
  const gone: string[] = [];
  for (let i = 0; i < ids.length; i += PARALLEL) {
    const slice = ids.slice(i, i + PARALLEL);
    const got = await Promise.all(
      slice.map(async (id) => {
        try {
          return await gjson<Thread>(ctx, `${API}/threads/${id}?format=full`);
        } catch (err) {
          if (err instanceof NotFound) return null;
          throw err;
        }
      }),
    );
    got.forEach((t, j) => {
      const doc = t ? threadToDocument(t) : null;
      if (doc) docs.push(doc);
      else gone.push(slice[j] as string);
    });
  }
  return { docs, gone };
}

async function* fullSync(ctx: GoogleCtx & { config: GmailConfig }, resync: boolean) {
  // The baseline history id is taken before listing, so nothing changed during the backfill is lost.
  const profile = await gjson<{ historyId: string }>(ctx, `${API}/profile`);
  const q = `newer_than:${ctx.config.backfillDays}d ${ctx.config.query}`.trim();
  const threadIds: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page: { messages?: { id: string; threadId: string }[]; nextPageToken?: string } =
      await gjson(
        ctx,
        `${API}/messages?maxResults=500&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ""}`,
      );
    for (const m of page.messages ?? [])
      if (!seen.has(m.threadId)) {
        seen.add(m.threadId);
        threadIds.push(m.threadId);
      }
    pageToken = page.nextPageToken;
  } while (pageToken);
  for (let i = 0; i < threadIds.length; i += THREADS_PER_BATCH) {
    const { docs, gone } = await fetchThreads(ctx, threadIds.slice(i, i + THREADS_PER_BATCH));
    const last = i + THREADS_PER_BATCH >= threadIds.length;
    // Until the backfill finishes the cursor stays unset, so a crash restarts it (idempotently).
    yield {
      documents: docs,
      deletedExternalIds: gone,
      cursor: (last ? { historyId: profile.historyId } : undefined) as GmailCursor,
      ...(resync ? { fullResync: true } : {}),
    };
  }
  if (!threadIds.length) yield { documents: [], cursor: { historyId: profile.historyId } };
}

export const gmail: Connector<GmailConfig, GmailCursor> = {
  id: "gmail",
  tier: "experimental",
  egress: () => ["gmail.googleapis.com", "www.googleapis.com"],
  displayName: "Gmail",
  permissions: "Reads mail (last 90 days by default); creates drafts after approval; never sends",
  configSchema: GmailConfigSchema,
  secrets: [],
  // compose: drafts (Phase 6). Code only calls the draft endpoints; see gmail-drafts.ts.
  oauth: googleOAuth([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ]),
  defaultIntervalMin: 10,
  readOnlyCapable: true,
  async *sync(ctx, cursor) {
    if (!cursor?.historyId) {
      yield* fullSync(ctx, false);
      return;
    }
    const changed = new Set<string>();
    let historyId = cursor.historyId;
    let pageToken: string | undefined;
    try {
      do {
        const page: {
          history?: {
            messagesAdded?: { message: Message }[];
            messagesDeleted?: { message: Message }[];
          }[];
          historyId: string;
          nextPageToken?: string;
        } = await gjson(
          ctx,
          `${API}/history?startHistoryId=${cursor.historyId}&historyTypes=messageAdded&historyTypes=messageDeleted&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`,
        );
        for (const h of page.history ?? [])
          for (const m of [...(h.messagesAdded ?? []), ...(h.messagesDeleted ?? [])])
            changed.add(m.message.threadId);
        historyId = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if (!(err instanceof NotFound)) throw err;
      ctx.log("Gmail history id expired; running a full resync.");
      yield* fullSync(ctx, true);
      return;
    }
    const ids = [...changed];
    for (let i = 0; i < ids.length; i += THREADS_PER_BATCH) {
      const { docs, gone } = await fetchThreads(ctx, ids.slice(i, i + THREADS_PER_BATCH));
      const last = i + THREADS_PER_BATCH >= ids.length;
      yield { documents: docs, deletedExternalIds: gone, cursor: last ? { historyId } : cursor };
    }
    if (!ids.length) yield { documents: [], cursor: { historyId } };
  },
  async health(ctx) {
    const p = await gjson<{ emailAddress: string; messagesTotal?: number }>(ctx, `${API}/profile`);
    return { status: "ok", message: `Signed in as ${p.emailAddress}`, account: p.emailAddress };
  },
  actions: () => [draftCreate, draftUpdate],
};

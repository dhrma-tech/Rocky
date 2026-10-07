import type { ConnectorAction, ExecContext } from "@rocky/connector-sdk";
import { z } from "zod";
import { gjson, gsend } from "./common.ts";

/**
 * Gmail drafts (actions.md, non-negotiable #1). Verified 2026-10-07:
 * - users.drafts.create: POST /gmail/v1/users/me/drafts {message: {raw, threadId}}, raw is a
 *   base64url RFC 2822 message; replies need threadId plus In-Reply-To/References headers.
 * - users.drafts.update: PUT /gmail/v1/users/me/drafts/{id} with the same body.
 * - Scope gmail.compose. That scope could also deliver mail; this file only ever calls the two
 *   draft endpoints above, and the no-send security test scans every package for delivery calls.
 * Idempotency: the draft carries an X-Rocky-Key header; before creating, recent drafts are checked.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Drafts checked for the idempotency header before creating a new one. */
const RECENT_DRAFTS = 10;

const noBreak = (s: string) => !/[\r\n]/.test(s);
const Email = z.email().max(320);
const DraftFields = {
  /** Gmail thread id to reply in; null for a new conversation. */
  threadId: z.string().min(1).max(100).nullable().default(null),
  to: z.array(Email).min(1).max(20),
  cc: z.array(Email).max(20).default([]),
  subject: z.string().trim().min(1).max(300).refine(noBreak, "one line"),
  body: z.string().min(1).max(20_000),
};

export const DraftCreateSchema = z.object(DraftFields).strict();
export type DraftCreate = z.infer<typeof DraftCreateSchema>;
export const DraftUpdateSchema = z
  .object({ draftId: z.string().min(1).max(200), ...DraftFields })
  .strict();
export type DraftUpdate = z.infer<typeof DraftUpdateSchema>;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
/** RFC 2047 encoded-word for non-ASCII header values. */
const header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

interface Headers {
  inReplyTo?: string;
  references?: string;
}

/** An RFC 2822 message: plain text UTF-8 body, base64 transfer encoding (76-char lines). */
export function rfc2822(d: DraftCreate, key: string, reply: Headers = {}): string {
  const lines = [
    `To: ${d.to.join(", ")}`,
    ...(d.cc.length ? [`Cc: ${d.cc.join(", ")}`] : []),
    `Subject: ${header(d.subject)}`,
    ...(reply.inReplyTo ? [`In-Reply-To: ${reply.inReplyTo}`] : []),
    ...(reply.references ? [`References: ${reply.references}`] : []),
    `X-Rocky-Key: ${key}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    ...(b64(d.body).match(/.{1,76}/g) ?? []),
  ];
  return lines.join("\r\n");
}

type MsgHeaders = { payload?: { headers?: { name: string; value: string }[] } };
/** A header value from a received message: untrusted, so line breaks are removed (no header injection). */
const headerOf = (m: MsgHeaders | undefined, name: string) =>
  m?.payload?.headers
    ?.find((h) => h.name.toLowerCase() === name.toLowerCase())
    ?.value.replace(/[\r\n]+/g, " ")
    .trim();

/** Reply headers from the thread's last message. */
async function replyHeaders(ctx: ExecContext, threadId: string): Promise<Headers> {
  const t = await gjson<{ messages?: MsgHeaders[] }>(
    ctx,
    `${API}/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
  );
  const last = t.messages?.at(-1);
  const id = headerOf(last, "Message-ID");
  if (!id) return {};
  const refs = headerOf(last, "References");
  return { inReplyTo: id, references: refs ? `${refs} ${id}` : id };
}

interface Draft {
  id: string;
  message: { id: string; threadId: string };
}

const result = (d: Draft, reused = false) => ({
  draftId: d.id,
  messageId: d.message.id,
  threadId: d.message.threadId,
  url: "https://mail.google.com/mail/u/0/#drafts",
  ...(reused ? { reused: true } : {}),
});

async function findByKey(ctx: ExecContext, key: string): Promise<Draft | null> {
  const list = await gjson<{ drafts?: Draft[] }>(ctx, `${API}/drafts?maxResults=${RECENT_DRAFTS}`);
  for (const d of list.drafts ?? []) {
    const full = await gjson<{ message?: MsgHeaders }>(
      ctx,
      `${API}/drafts/${encodeURIComponent(d.id)}?format=metadata`,
    );
    if (headerOf(full.message, "X-Rocky-Key") === key) return d;
  }
  return null;
}

const describe = (p: DraftCreate) => ({
  target: p.to.join(", "),
  summary: `Gmail draft "${p.subject}"${p.threadId ? " (reply in thread)" : ""}. Saved as a draft; you send it from Gmail.`,
  diff: { to: p.to, cc: p.cc, subject: p.subject, body: p.body },
});

export const draftCreate: ConnectorAction<DraftCreate> = {
  type: "gmail.draftCreate",
  title: "Create Gmail draft",
  schema: DraftCreateSchema,
  risk: "low",
  describe,
  async execute(p, ctx) {
    const existing = await findByKey(ctx, ctx.idempotencyKey);
    if (existing) return result(existing, true);
    const reply = p.threadId ? await replyHeaders(ctx, p.threadId) : {};
    const created = await gsend<Draft>(
      ctx,
      "POST",
      `${API}/drafts`,
      {
        message: {
          raw: b64url(rfc2822(p, ctx.idempotencyKey, reply)),
          ...(p.threadId ? { threadId: p.threadId } : {}),
        },
      },
      ctx.signal,
    );
    return result(created);
  },
};

export const draftUpdate: ConnectorAction<DraftUpdate> = {
  type: "gmail.draftUpdate",
  title: "Update Gmail draft",
  schema: DraftUpdateSchema,
  risk: "low",
  describe: (p) => ({ ...describe(p), summary: `Update Gmail draft "${p.subject}"` }),
  async execute(p, ctx) {
    const reply = p.threadId ? await replyHeaders(ctx, p.threadId) : {};
    // PUT replaces the draft, so a retry writes the same content again.
    const updated = await gsend<Draft>(
      ctx,
      "PUT",
      `${API}/drafts/${encodeURIComponent(p.draftId)}`,
      {
        id: p.draftId,
        message: {
          raw: b64url(rfc2822(p, ctx.idempotencyKey, reply)),
          ...(p.threadId ? { threadId: p.threadId } : {}),
        },
      },
      ctx.signal,
    );
    return result(updated);
  },
};

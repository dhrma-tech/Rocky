/**
 * ntfy (https://docs.ntfy.sh/publish/, checked 2026-10-21): POST <server>/<topic> with the message
 * as the body; `Title`, `Priority` (1–5 or min/low/default/high/max), `Tags` and `Click` headers;
 * an access token as `Authorization: Bearer tk_…`. Messages over 4,096 bytes become attachments,
 * so Rocky keeps them short. The topic name is the access key on a public server, so it is a
 * secret (D-065).
 */

export interface PhoneMessage {
  title: string;
  text: string;
  /** Opens this link when the notification is tapped (the phone's address for Rocky). */
  click?: string;
  priority: "default" | "high";
}

const MAX_BYTES = 3500;

/** Trims to fit well under ntfy's 4,096-byte message limit, on a character boundary. */
export function fitMessage(text: string, max = MAX_BYTES): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  let out = text;
  while (enc.encode(`${out}…`).length > max) out = out.slice(0, -16);
  return `${out}…`;
}

/** The request for one message. Pure, so the wire format is tested without a network. */
export function ntfyRequest(
  server: string,
  topic: string,
  token: string | null,
  m: PhoneMessage,
): { url: string; init: RequestInit } {
  const base = server.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Title: m.title,
    Priority: m.priority,
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (m.click) headers.Click = m.click;
  if (token) headers.Authorization = `Bearer ${token}`;
  return {
    url: `${base}/${encodeURIComponent(topic)}`,
    init: { method: "POST", headers, body: fitMessage(m.text) },
  };
}

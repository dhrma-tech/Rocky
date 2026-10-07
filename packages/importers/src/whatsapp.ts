import { chatDocuments } from "./chat.ts";
import type { ArchiveFiles, ChatMessage, ParsedArchive } from "./types.ts";

/**
 * One message header line, Android or iOS, any common locale:
 *   12/31/24, 9:41 PM - Alice: Hi          (Android, US)
 *   31.12.24, 21:41 - Alice: Hi            (Android, DE)
 *   [31/12/2024, 21:41:05] Alice: Hi       (iOS, UK)
 *   [2024-12-31 21:41:05] Alice: Hi        (ISO)
 * Groups: date parts a b c, hour, minute, second, am/pm letter, rest.
 */
const LINE =
  /^\u200e?\[?(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:[\s\u202f\u00a0]*([AaPp])\.?\s?[Mm]\.?)?\]?(?:\s+-\s+|\s+)(.*)$/;

const MEDIA =
  /^(<Media omitted>|<attached: [^>]+>|(image|video|audio|sticker|GIF|document|Contact card) omitted|This message was deleted\.?|You deleted this message\.?|null)$/i;

const pad = (n: number) => String(n).padStart(2, "0");

interface Header {
  line: number;
  a: number;
  b: number;
  c: number;
  aLen: number;
  hour: number;
  minute: number;
  second: number;
  ampm: string | undefined;
  rest: string;
  sep: string;
}

/** True when the text looks like a WhatsApp export (a message header in its first lines). */
export function looksLikeWhatsApp(text: string): boolean {
  return text.split(/\r?\n/, 20).some((l) => LINE.test(l.replace(/^\ufeff/, "")) && /: /.test(l));
}

type Order = "ymd" | "dmy" | "mdy";

/** Day/month order: a part over 12 settles it; otherwise "." and 24 h mean d/m, AM/PM means m/d. */
function inferOrder(headers: Header[]): Order {
  if (headers.some((h) => h.aLen === 4)) return "ymd";
  if (headers.some((h) => h.a > 12)) return "dmy";
  if (headers.some((h) => h.b > 12)) return "mdy";
  if (headers.some((h) => h.sep === ".")) return "dmy";
  return headers.some((h) => h.ampm) ? "mdy" : "dmy";
}

export function chatNameFrom(fileName: string, archiveName: string): string {
  const base = fileName.replace(/^.*\//, "").replace(/\.txt$/i, "");
  const pick = base === "_chat" || /^chat$/i.test(base) ? archiveName : base;
  return (
    pick
      .replace(/^WhatsApp Chat (with|-)\s*/i, "")
      .replace(/^WhatsApp-Chat mit\s*/i, "")
      .trim() || "chat"
  );
}

/** Parses one exported chat. Message ids are `L<line>@<ts>` (line number + timestamp). */
export function parseWhatsAppChat(text: string): ChatMessage[] {
  const lines = text.replace(/^\ufeff/, "").split(/\r?\n/);
  const headers: Header[] = [];
  const bodies: string[][] = [];
  lines.forEach((raw, i) => {
    const m = LINE.exec(raw);
    if (m) {
      const [, a = "", b = "", c = "", h = "", mi = "", s, ap, rest = ""] = m;
      headers.push({
        line: i + 1,
        a: Number(a),
        b: Number(b),
        c: Number(c),
        aLen: a.length,
        hour: Number(h),
        minute: Number(mi),
        second: Number(s ?? 0),
        ampm: ap?.toLowerCase(),
        rest,
        sep: raw.replace(/^\u200e?\[?\d{1,4}/, "")[0] ?? "/",
      });
      bodies.push([]);
    } else bodies.at(-1)?.push(raw);
  });
  const order = inferOrder(headers);
  const out: ChatMessage[] = [];
  headers.forEach((h, i) => {
    const colon = h.rest.indexOf(": ");
    if (colon <= 0) return; // System line: encryption notice, "Alice added Bob", …
    const author = h.rest
      .slice(0, colon)
      .replace(/\u200e/g, "")
      .trim();
    const text = [h.rest.slice(colon + 2), ...(bodies[i] ?? [])]
      .join("\n")
      .replace(/\u200e/g, "")
      .trim();
    if (!text || MEDIA.test(text)) return;
    let [y, mo, d] =
      order === "ymd" ? [h.a, h.b, h.c] : order === "dmy" ? [h.c, h.b, h.a] : [h.c, h.a, h.b];
    if (y < 100) y += 2000;
    let hour = h.hour;
    if (h.ampm === "p" && hour < 12) hour += 12;
    if (h.ampm === "a" && hour === 12) hour = 0;
    // Exports carry the phone's local time and no zone; read it as this machine's local time.
    const ts = new Date(y, mo - 1, d, hour, h.minute, h.second).getTime();
    if (Number.isNaN(ts)) return;
    out.push({
      id: `L${h.line}@${ts}`,
      ts,
      author,
      text,
      label: `${y}-${pad(mo)}-${pad(d)} ${pad(hour)}:${pad(h.minute)}`,
      month: `${y}-${pad(mo)}`,
    });
  });
  return out;
}

export function parseWhatsApp(archive: ArchiveFiles): ParsedArchive {
  const decoder = new TextDecoder("utf-8");
  const result: ParsedArchive = { format: "whatsapp", documents: [], messages: 0, warnings: [] };
  for (const [file, bytes] of archive.files) {
    if (!/\.txt$/i.test(file)) continue;
    const text = decoder.decode(bytes);
    if (!looksLikeWhatsApp(text)) {
      result.warnings.push(`${file}: not a WhatsApp chat export, skipped`);
      continue;
    }
    const name = chatNameFrom(file, archive.name);
    const messages = parseWhatsAppChat(text);
    result.messages += messages.length;
    result.documents.push(
      ...chatDocuments({
        format: "whatsapp",
        archive: archive.name,
        conversationId: name.toLowerCase(),
        conversationName: name,
        messages,
      }),
    );
  }
  return result;
}

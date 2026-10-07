import type { AnchorUnit, SourceDocument } from "@rocky/connector-sdk";
import type { ArchiveFormat, ChatMessage } from "./types.ts";

const LABEL: Record<ArchiveFormat, string> = {
  whatsapp: "WhatsApp",
  discord: "Discord",
  instagram: "Instagram",
  x: "X",
  linkedin: "LinkedIn",
};

/** A new unit starts after this much silence, or once a unit holds this much text. */
const BURST_GAP_MS = 30 * 60_000;
const BURST_CHARS = 1500;

const pad = (n: number) => String(n).padStart(2, "0");

/** Display time and month for an absolute timestamp (exports with time zones are shown in UTC). */
export function utcLabel(ts: number): { label: string; month: string } {
  const d = new Date(ts);
  const month = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  return {
    label: `${month}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`,
    month,
  };
}

/** Makes ids unique within a conversation by suffixing repeats (#2, #3, …). */
export function uniqueIds(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Map<string, number>();
  return messages.map((m) => {
    const n = (seen.get(m.id) ?? 0) + 1;
    seen.set(m.id, n);
    return n === 1 ? m : { ...m, id: `${m.id}#${n}` };
  });
}

/**
 * Splits one conversation into a document per month. Consecutive messages are grouped into
 * bursts, each a unit anchored at its first message, so chunks stay readable and a citation
 * opens the exact message where that stretch of conversation starts.
 */
export function chatDocuments(opts: {
  format: ArchiveFormat;
  archive: string;
  conversationId: string;
  conversationName: string;
  messages: ChatMessage[];
  uri?: (m: ChatMessage) => string | undefined;
}): SourceDocument[] {
  const byMonth = new Map<string, ChatMessage[]>();
  for (const m of opts.messages) {
    if (!m.text.trim()) continue;
    const list = byMonth.get(m.month) ?? [];
    list.push(m);
    byMonth.set(m.month, list);
  }
  const docs: SourceDocument[] = [];
  for (const [month, msgs] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    msgs.sort((a, b) => a.ts - b.ts);
    const units: AnchorUnit[] = [];
    let cur: { first: ChatMessage; lines: string[]; size: number; last: number } | null = null;
    const flush = () => {
      if (!cur) return;
      units.push({
        anchor: { kind: "message", messageId: cur.first.id, threadId: opts.conversationId },
        heading: cur.first.label,
        text: cur.lines.join("\n\n"),
      });
      cur = null;
    };
    for (const m of msgs) {
      // Labels are "YYYY-MM-DD HH:MM[ UTC]"; the unit heading carries the date.
      const line = `**${m.author}** (${m.label.slice(11)}): ${m.text.trim()}`;
      if (cur && (m.ts - cur.last > BURST_GAP_MS || cur.size + line.length > BURST_CHARS)) flush();
      if (!cur) cur = { first: m, lines: [], size: 0, last: m.ts };
      cur.lines.push(line);
      cur.size += line.length;
      cur.last = m.ts;
    }
    flush();
    const first = msgs[0];
    const last = msgs.at(-1);
    if (!first || !last) continue;
    const uri = opts.uri?.(first);
    docs.push({
      externalId: `${opts.format}:${opts.conversationId}:${month}`,
      sourceType: "chat",
      title: `${LABEL[opts.format]} · ${opts.conversationName} · ${month}`,
      createdAt: first.ts,
      updatedAt: last.ts,
      mime: "text/plain",
      ...(uri ? { uri } : {}),
      body: { kind: "text", units },
      meta: {
        archive: opts.archive,
        conversation: opts.conversationName,
        messages: msgs.length,
        participants: [...new Set(msgs.map((m) => m.author))].slice(0, 50),
      },
    });
  }
  return docs;
}

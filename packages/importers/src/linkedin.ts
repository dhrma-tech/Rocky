import type { AnchorUnit, SourceDocument } from "@rocky/connector-sdk";
import { chatDocuments, uniqueIds, utcLabel } from "./chat.ts";
import { csvRecords, parseCsv } from "./csv.ts";
import type { ArchiveFiles, ChatMessage, ParsedArchive } from "./types.ts";

const MESSAGES_FILE = /(?:^|\/)messages\.csv$/i;
const CONNECTIONS_FILE = /(?:^|\/)connections\.csv$/i;

const text = (b: Uint8Array) => new TextDecoder().decode(b);

export const isLinkedIn = (archive: ArchiveFiles) =>
  [...archive.files].some(
    ([p, b]) =>
      CONNECTIONS_FILE.test(p) ||
      (MESSAGES_FILE.test(p) && /CONVERSATION ID/i.test(text(b.subarray(0, 400)))),
  );

/** "2024-01-02 03:04:05 UTC" (also accepts ISO). */
function parseDate(s: string): number {
  const t = s
    .trim()
    .replace(/\s*UTC$/i, "Z")
    .replace(" ", "T");
  return Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`);
}

/** messages.csv grouped by CONVERSATION ID; Connections.csv as one document of rows. */
export function parseLinkedIn(archive: ArchiveFiles): ParsedArchive {
  const result: ParsedArchive = { format: "linkedin", documents: [], messages: 0, warnings: [] };
  for (const [p, bytes] of archive.files) {
    if (MESSAGES_FILE.test(p)) {
      const records = csvRecords(parseCsv(text(bytes)));
      if (records.length && !("CONVERSATION ID" in (records[0] ?? {}))) {
        result.warnings.push(`${p}: no CONVERSATION ID column, skipped`);
        continue;
      }
      const convs = new Map<string, { title: string; messages: ChatMessage[] }>();
      for (const r of records) {
        const conv = r["CONVERSATION ID"] ?? "";
        const ts = parseDate(r.DATE ?? "");
        const body = [r.SUBJECT, r.CONTENT].filter((s) => s?.trim()).join("\n");
        if (!conv || Number.isNaN(ts) || !body) continue;
        const c = convs.get(conv) ?? { title: "", messages: [] };
        c.title ||= r["CONVERSATION TITLE"]?.trim() || "";
        const from = r.FROM?.trim() || "unknown";
        c.messages.push({ id: `${conv}@${ts}`, ts, author: from, text: body, ...utcLabel(ts) });
        convs.set(conv, c);
      }
      for (const [conv, c] of convs) {
        const messages = uniqueIds(c.messages.sort((a, b) => a.ts - b.ts));
        const people = [...new Set(messages.map((m) => m.author))].join(", ");
        result.messages += messages.length;
        result.documents.push(
          ...chatDocuments({
            format: "linkedin",
            archive: archive.name,
            conversationId: conv,
            conversationName: c.title || people || "conversation",
            messages,
          }),
        );
      }
    } else if (CONNECTIONS_FILE.test(p)) {
      const rows = parseCsv(text(bytes));
      // Recent exports start with a few "Notes:" lines before the header.
      const header = rows.findIndex((r) => r.some((f) => /^first name$/i.test(f.trim())));
      if (header < 0) {
        result.warnings.push(`${p}: no "First Name" header, skipped`);
        continue;
      }
      const units: AnchorUnit[] = csvRecords(rows, header).flatMap((r, i) => {
        const name = `${r["FIRST NAME"] ?? ""} ${r["LAST NAME"] ?? ""}`.trim();
        if (!name) return [];
        const role = [r.POSITION, r.COMPANY].filter((s) => s?.trim()).join(" at ");
        const since = r["CONNECTED ON"] ? `, connected ${r["CONNECTED ON"]}` : "";
        return [
          {
            anchor: { kind: "row" as const, rowId: r.URL?.trim() || `row-${i + 1}` },
            text: `${name}${role ? `: ${role}` : ""}${since}${r["EMAIL ADDRESS"] ? ` (${r["EMAIL ADDRESS"]})` : ""}`,
          },
        ];
      });
      if (!units.length) continue;
      const now = Date.now();
      const doc: SourceDocument = {
        externalId: "linkedin:connections",
        sourceType: "text",
        title: "LinkedIn · Connections",
        createdAt: now,
        updatedAt: now,
        mime: "text/csv",
        body: { kind: "text", units },
        meta: { archive: archive.name, connections: units.length },
      };
      result.documents.push(doc);
    }
  }
  return result;
}

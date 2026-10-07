import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SourceDocument } from "@rocky/connector-sdk";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  detectArchive,
  filesFromZipStream,
  fixMojibake,
  parseArchive,
  parseCsv,
  parseWhatsAppChat,
  readArchive,
  UnrecognizedArchive,
} from "../src/index.ts";

const fixture = (...p: string[]) => path.join(import.meta.dirname, "fixtures", ...p);

/** Every unit of every document, flattened. */
const units = (docs: SourceDocument[]) =>
  docs.flatMap((d) => (d.body.kind === "text" ? (d.body.units ?? []) : []));
const allText = (docs: SourceDocument[]) =>
  units(docs)
    .map((u) => u.text)
    .join("\n");

describe("WhatsApp", () => {
  it("parses a US Android export (m/d/y, 12 h) with multi-line messages and system lines", async () => {
    const text = fs.readFileSync(fixture("whatsapp", "WhatsApp Chat with Sam Rivera.txt"), "utf8");
    const msgs = parseWhatsAppChat(text);
    expect(msgs.map((m) => m.author)).toEqual([
      "Sam Rivera",
      "Jordan Lee",
      "Jordan Lee",
      "Sam Rivera",
    ]);
    expect(msgs[1]?.text).toBe("Yes, I will send the draft by Friday.\nAlso bring the calculator.");
    expect(msgs[2]?.label).toBe("2024-12-30 23:58");
    expect(msgs[3]?.label).toBe("2025-01-02 08:05");
    // Line number + timestamp, against the phone's local clock.
    expect(msgs[0]?.id).toBe(`L2@${new Date(2024, 11, 30, 21, 41).getTime()}`);
  });

  it("parses a German iOS export (d.m.y, 24 h, U+200E marks) and drops media placeholders", async () => {
    const text = fs.readFileSync(fixture("whatsapp", "_chat.txt"), "utf8");
    const msgs = parseWhatsAppChat(text);
    expect(msgs).toHaveLength(3);
    expect(msgs[1]?.text).toBe("Ja, im Café am Markt.");
    expect(msgs[2]?.label).toBe("2025-01-13 09:00");
    expect(msgs[0]?.id).toMatch(/^L1@\d+$/);
  });

  it("splits a chat into monthly documents with message anchors", async () => {
    const archive = await readArchive(fixture("whatsapp", "WhatsApp Chat with Sam Rivera.txt"));
    expect(detectArchive(archive)).toBe("whatsapp");
    const { documents, messages } = parseArchive(archive);
    expect(messages).toBe(4);
    expect(documents.map((d) => d.title)).toEqual([
      "WhatsApp · Sam Rivera · 2024-12",
      "WhatsApp · Sam Rivera · 2025-01",
    ]);
    expect(documents[0]?.externalId).toBe("whatsapp:sam rivera:2024-12");
    expect(documents[0]?.sourceType).toBe("chat");
    // 9:41 and 9:43 PM are one burst; 11:58 PM comes after a 2 h gap.
    const dec = units([documents[0] as SourceDocument]);
    expect(dec).toHaveLength(2);
    expect(dec[0]?.anchor).toMatchObject({ kind: "message", threadId: "sam rivera" });
    expect(dec[0]?.text).toContain("**Jordan Lee** (21:43)");
    expect(allText(documents)).not.toContain("Media omitted");
    expect(allText(documents)).not.toContain("end-to-end");
  });

  it("reads a zip export and takes the chat name from the zip", async () => {
    const bytes = zipSync({
      "_chat.txt": fs.readFileSync(fixture("whatsapp", "_chat.txt")),
      "00000001-PHOTO-2024-12-31.jpg": new Uint8Array([0xff, 0xd8]),
    });
    const archive = await filesFromZipStream("WhatsApp Chat - Anna Becker.zip", [
      bytes.subarray(0, 50),
      bytes.subarray(50),
    ]);
    expect([...archive.files.keys()]).toEqual(["_chat.txt"]);
    const { documents } = parseArchive(archive);
    expect(documents[0]?.title).toBe("WhatsApp · Anna Becker · 2024-12");
  });
});

describe("Discord", () => {
  it("parses messages.json per channel with exact snowflake ids and index names", async () => {
    const archive = await readArchive(fixture("discord"));
    expect(detectArchive(archive)).toBe("discord");
    const { documents, messages } = parseArchive(archive);
    expect(messages).toBe(4);
    const titles = documents.map((d) => d.title).sort();
    expect(titles).toEqual([
      "Discord · Direct Message with casey#0 · 2024-11",
      "Discord · general in Study Group · 2024-11",
      "Discord · general in Study Group · 2024-12",
    ]);
    const anchors = units(documents).map((u) => u.anchor);
    expect(anchors).toContainEqual({
      kind: "message",
      messageId: "1180000000000000001",
      threadId: "111",
    });
    expect(allText(documents)).toContain("[attachment]");
    const general = documents.find(
      (d) => d.title.endsWith("2024-11") && d.title.includes("general"),
    );
    expect(general?.uri).toBe("https://discord.com/channels/900/111/1180000000000000001");
  });

  it("parses the older messages.csv layout", async () => {
    const { documents } = parseArchive(await readArchive(fixture("discord-csv")));
    expect(documents.map((d) => d.title)).toEqual(["Discord · #random in Old Server · 2020-05"]);
    expect(allText(documents)).toContain('Hello, world "quoted"');
    expect(allText(documents)).toContain("multi\nline");
  });
});

describe("Instagram", () => {
  it("decodes Latin-1-escaped UTF-8 and anchors by thread and timestamp", async () => {
    const archive = await readArchive(fixture("instagram"));
    expect(detectArchive(archive)).toBe("instagram");
    const { documents, messages } = parseArchive(archive);
    expect(messages).toBe(3); // the photo-only message has no text
    expect(documents[0]?.title).toBe("Instagram · Alex Smith · 2024-06");
    const text = allText(documents);
    expect(text).toContain("Café at 5? 😀");
    const ids = units(documents).map((u) =>
      u.anchor.kind === "message" ? u.anchor.messageId : "",
    );
    expect(ids[0]).toBe("alexsmith_123@1717235000000");
    // Two messages in the same millisecond get distinct ids (#2) inside one burst.
    expect(text).toContain("Two of them");
  });

  it("leaves real Unicode alone", async () => {
    expect(fixMojibake("naïve 😀")).toBe("naïve 😀");
    expect(fixMojibake("Ã©")).toBe("é");
  });
});

describe("X", () => {
  it("strips the window.YTD wrapper and anchors by tweet id", async () => {
    const archive = await readArchive(fixture("x"));
    expect(detectArchive(archive)).toBe("x");
    const { documents } = parseArchive(archive);
    expect(documents.map((d) => d.title)).toEqual([
      "X · @rocky_test posts · 2024-06",
      "X · @rocky_test posts · 2024-07",
    ]);
    expect(units(documents)[0]?.anchor).toEqual({
      kind: "message",
      messageId: "1800000000000000001",
      threadId: "rocky_test",
    });
    expect(documents[0]?.uri).toBe("https://x.com/i/web/status/1800000000000000001");
    expect(allText(documents)).toContain("reply to @friend");
  });
});

describe("LinkedIn", () => {
  it("groups messages by conversation and reads Connections.csv after its notes preamble", async () => {
    const archive = await readArchive(fixture("linkedin"));
    expect(detectArchive(archive)).toBe("linkedin");
    const { documents, messages } = parseArchive(archive);
    expect(messages).toBe(2);
    const chat = documents.find((d) => d.sourceType === "chat");
    expect(chat?.title).toBe("LinkedIn · Priya Shah, Me · 2024-03");
    expect(units([chat as SourceDocument])[0]?.anchor).toEqual({
      kind: "message",
      messageId: `2-abc==@${Date.parse("2024-03-05T14:00:00Z")}`,
      threadId: "2-abc==",
    });
    expect(allText([chat as SourceDocument])).toContain("Internship\nHi, are you open");
    const conns = documents.find((d) => d.externalId === "linkedin:connections");
    expect(units([conns as SourceDocument]).map((u) => u.text)).toEqual([
      "Priya Shah: Recruiter at Acme, connected 05 Mar 2024",
      "Tom Ng: Engineer at Beta Labs, connected 10 Jan 2023 (tom@example.com)",
    ]);
    expect(units([conns as SourceDocument])[0]?.anchor).toEqual({
      kind: "row",
      rowId: "https://www.linkedin.com/in/priya",
    });
  });
});

describe("detection and errors", () => {
  it("names the files it did not recognize", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rocky-imp-"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "just some notes\n");
    await expect(readArchive(dir).then(parseArchive)).rejects.toThrow(UnrecognizedArchive);
    await expect(readArchive(dir).then(parseArchive)).rejects.toThrow(/Found: notes\.txt/);
  });

  it("is deterministic, so re-importing yields identical documents", async () => {
    const a = parseArchive(await readArchive(fixture("discord")));
    const b = parseArchive(await readArchive(fixture("discord")));
    expect(JSON.stringify(a.documents)).toBe(JSON.stringify(b.documents));
  });

  it("parses quoted CSV fields", async () => {
    expect(parseCsv('a,b\r\n"x, ""y""",z\n')).toEqual([
      ["a", "b"],
      ['x, "y"', "z"],
    ]);
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// SECURITY.md "No email is ever sent": Gmail is drafts-only. CI also runs `pnpm test:security`.

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const SCAN = ["apps", "packages"];
const FORBIDDEN = [
  /\bmessages\s*\.\s*send\b/i,
  /\bdrafts\s*\.\s*send\b/i,
  /gmail[^\n]{0,80}\/(messages|drafts)\/send\b/i,
  /\/gmail\/v1\/users\/[^\n]{0,40}\/messages\/send/i,
];

function* sources(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && full !== import.meta.filename) yield full;
  }
}

describe("no email is ever sent", () => {
  it("no source file calls a Gmail send endpoint", () => {
    const hits: string[] = [];
    for (const root of SCAN)
      for (const file of sources(path.join(ROOT, root))) {
        const text = fs.readFileSync(file, "utf8");
        for (const re of FORBIDDEN)
          if (re.test(text)) hits.push(`${path.relative(ROOT, file)}: ${re}`);
      }
    expect(hits).toEqual([]);
  });

  it("the patterns catch the calls they are meant to catch", () => {
    const samples = [
      "gmail.users.messages.send({ userId: 'me' })",
      "await drafts.send(id)",
      "fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')",
    ];
    for (const s of samples)
      expect(
        FORBIDDEN.some((re) => re.test(s)),
        s,
      ).toBe(true);
  });
});

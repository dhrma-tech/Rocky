// UI spec 14: the Files screen lists every local file Rocky read, flags ones gone from disk, and
// reveals a file only by the path in the store.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Db,
  ingestPath,
  listReadFiles,
  readFilePreview,
  revealReadFile,
  upsertDocument,
} from "../src/index.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { memoryDb, tempDir } from "./helpers.ts";

let db: Db;
let dir: string;
beforeEach(() => {
  db = memoryDb();
  dir = tempDir();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("files Rocky read", () => {
  it("lists local files newest first with size, and marks a deleted one", async () => {
    const notes = path.join(dir, "notes");
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, "plan.md"), "# Plan\n\nShip the Files screen on Friday.");
    fs.writeFileSync(path.join(notes, "budget.txt"), "Budget is 40k for Q4.");
    await ingestPath(db, path.join(dir, "blobs"), notes);
    // A connector document is not a local file.
    const { text, blocks } = markdownBlocks("# Mail\n\nHello.");
    upsertDocument(db, {
      parsed: {
        title: "Mail",
        sourceType: "email",
        text,
        units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
      },
      connectorId: "gmail",
      externalId: "m1",
    });
    const files = listReadFiles(db);
    expect(files.map((f) => f.name).sort()).toEqual(["budget.txt", "plan.md"]);
    expect(files.every((f) => f.exists && (f.size ?? 0) > 0 && f.textChars > 0)).toBe(true);
    expect(listReadFiles(db, { q: "budg" }).map((f) => f.name)).toEqual(["budget.txt"]);
    // A % in the search is literal, not a wildcard.
    expect(listReadFiles(db, { q: "%" })).toEqual([]);

    fs.rmSync(path.join(notes, "plan.md"));
    const plan = listReadFiles(db).find((f) => f.name === "plan.md");
    expect(plan).toMatchObject({ exists: false, size: null });
    expect(readFilePreview(db, plan?.documentId as string)?.text).toContain(
      "Ship the Files screen",
    );
  });

  it("reveals by the stored path with no shell, and refuses unknown or missing files", async () => {
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "hello there");
    await ingestPath(db, path.join(dir, "blobs"), f);
    const [read] = listReadFiles(db);
    const id = read?.documentId as string;
    const stored = read?.path as string;
    expect(stored).toBe(path.resolve(f));
    const calls: [string, string[]][] = [];
    const run = (cmd: string, args: string[]) => void calls.push([cmd, args]);
    expect(revealReadFile(db, id, "win32", run)).toBe("revealed");
    expect(revealReadFile(db, id, "darwin", run)).toBe("revealed");
    expect(calls).toEqual([
      ["explorer.exe", [`/select,${stored}`]],
      ["open", ["-R", stored]],
    ]);
    expect(revealReadFile(db, "nope", "win32", run)).toBe("unknown");
    fs.rmSync(f);
    expect(revealReadFile(db, id, "win32", run)).toBe("missing");
    expect(calls).toHaveLength(2);
  });
});

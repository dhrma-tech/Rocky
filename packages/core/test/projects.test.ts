// UI spec 12, D-017, D-047: a project is a name and a folder; its notebook scope is that folder.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveProject,
  createProject,
  type Db,
  listProjects,
  listWatchedFolders,
  moveProject,
  renameProject,
} from "../src/index.ts";
import { ingestFile } from "../src/ingest/ingest-file.ts";
import { memoryDb, tempDir } from "./helpers.ts";

let db: Db;
let root: string;
let blobs: string;
beforeEach(() => {
  db = memoryDb();
  root = tempDir();
  blobs = tempDir();
});
afterEach(() => {
  db.close();
  for (const d of [root, blobs]) fs.rmSync(d, { recursive: true, force: true });
});

const file = async (rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  await ingestFile(db, blobs, f);
};

describe("projects", () => {
  it("scope exactly the project folder (recursively), watch it, and survive rename, move and archive", async () => {
    await file("launch/plan.md", "# Plan\n\nShip in November.");
    await file("launch/notes/day1.md", "# Day 1\n\nKickoff.");
    await file("launch-old/plan.md", "# Old plan\n\nShip in May."); // a sibling with the same prefix
    await file("other/x.md", "# Other\n\nNot this project.");
    const p = createProject(db, { name: "Launch", folder: path.join(root, "launch") });
    expect(p).toMatchObject({ name: "Launch", folderExists: true, documentCount: 2 });
    expect(listWatchedFolders(db).map((w) => path.resolve(w.path))).toContain(
      path.join(root, "launch"),
    );
    expect(() => createProject(db, { name: "Again", folder: path.join(root, "launch") })).toThrow(
      /already uses/,
    );
    expect(() => createProject(db, { name: "Nope", folder: path.join(root, "missing") })).toThrow(
      /isn't a folder/,
    );
    expect(renameProject(db, p.id, "Launch 2026").name).toBe("Launch 2026");
    expect(moveProject(db, p.id, path.join(root, "other")).documentCount).toBe(1);
    archiveProject(db, p.id);
    expect(listProjects(db)).toEqual([]);
    expect(listProjects(db, { archived: true }).map((x) => x.name)).toEqual(["Launch 2026"]);
  });

  it("says when the folder moved or was deleted", () => {
    fs.mkdirSync(path.join(root, "gone"));
    const p = createProject(db, { name: "Gone", folder: path.join(root, "gone") });
    fs.rmSync(path.join(root, "gone"), { recursive: true });
    expect(listProjects(db).find((x) => x.id === p.id)?.folderExists).toBe(false);
  });
});

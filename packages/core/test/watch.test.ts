import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWatchedFolder,
  FolderWatcher,
  listWatchedFolders,
  removeWatchedFolder,
} from "../src/capture/watch.ts";
import type { Db } from "../src/index.ts";
import { memoryDb, tempDir } from "./helpers.ts";

let db: Db;
let dir: string;
let blobs: string;
let watcher: FolderWatcher;

const docs = () =>
  (
    db.prepare("select title, external_id from documents order by title").all() as {
      title: string;
      external_id: string;
    }[]
  ).map((d) => d.title);

/** Polls until `check` passes; file events are asynchronous. */
async function eventually(check: () => void, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      await watcher.idle();
      check();
      return;
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

beforeEach(() => {
  db = memoryDb();
  dir = tempDir();
  blobs = path.join(dir, ".blobs");
  fs.mkdirSync(path.join(dir, "notes", "sub"), { recursive: true });
  watcher = new FolderWatcher({ db, blobsDir: blobs, settleMs: 50 });
});
afterEach(async () => {
  await watcher.stop();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("watched folders", () => {
  it("stores folders once and refuses files", () => {
    const notes = path.join(dir, "notes");
    const a = addWatchedFolder(db, notes);
    expect(addWatchedFolder(db, notes).id).toBe(a.id);
    expect(() => addWatchedFolder(db, path.join(dir, "missing"))).toThrow(/Not a folder/);
    expect(listWatchedFolders(db)).toHaveLength(1);
    expect(removeWatchedFolder(db, notes)).toBe(true);
    expect(listWatchedFolders(db)).toEqual([]);
  });

  it("ingests existing and new files, re-ingests changes, and removes deleted files", async () => {
    const notes = path.join(dir, "notes");
    fs.writeFileSync(path.join(notes, "a.md"), "# Alpha\n\nFirst note.");
    fs.writeFileSync(path.join(notes, "image.png"), "not text");
    fs.writeFileSync(path.join(notes, ".hidden.md"), "# Hidden\n\nSecret.");
    addWatchedFolder(db, notes);
    await watcher.start();
    expect(docs()).toEqual(["Alpha"]);

    fs.writeFileSync(path.join(notes, "sub", "b.md"), "# Beta\n\nSecond note.");
    await eventually(() => expect(docs()).toEqual(["Alpha", "Beta"]));

    fs.writeFileSync(path.join(notes, "a.md"), "# Alpha v2\n\nEdited.");
    await eventually(() => expect(docs()).toEqual(["Alpha v2", "Beta"]));

    fs.rmSync(path.join(notes, "sub", "b.md"));
    await eventually(() => expect(docs()).toEqual(["Alpha v2"]));
    // Alpha was embedded twice (created, edited); Beta's job went with Beta on delete.
    expect(
      db.prepare("select count(*) as n from jobs where type = 'embed_document'").get(),
    ).toEqual({ n: 2 });
  });

  it("does not descend into subfolders when not recursive", async () => {
    const notes = path.join(dir, "notes");
    fs.writeFileSync(path.join(notes, "top.md"), "# Top\n\nx");
    fs.writeFileSync(path.join(notes, "sub", "deep.md"), "# Deep\n\ny");
    addWatchedFolder(db, notes, { recursive: false });
    await watcher.start();
    expect(docs()).toEqual(["Top"]);
  });

  it("reconciles changes made while not watching", async () => {
    const notes = path.join(dir, "notes");
    fs.writeFileSync(path.join(notes, "a.md"), "# Alpha\n\nFirst.");
    addWatchedFolder(db, notes);
    await watcher.start();
    await watcher.stop();
    fs.writeFileSync(path.join(notes, "c.md"), "# Gamma\n\nAdded offline.");
    fs.rmSync(path.join(notes, "a.md"));
    await watcher.start();
    expect(docs()).toEqual(["Gamma"]);
  });
});

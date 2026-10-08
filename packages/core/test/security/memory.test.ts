// Roadmap A5: memory is plain files with provenance; model-suggested facts go through the
// approval queue and are saved only with a quote that is really in the source; history is kept.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionRegistry } from "../../src/actions/registry.ts";
import { ActionService } from "../../src/actions/service.ts";
import {
  checkPath,
  type Db,
  exportMemory,
  factLine,
  forgetFact,
  listMemory,
  MEMORY_ADD,
  MemoryError,
  memoryAddAction,
  memoryHistory,
  parseFacts,
  readMemoryContent,
  rememberUserFact,
  saveMemoryFile,
  suggestMemories,
} from "../../src/index.ts";
import { markdownBlocks } from "../../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../../src/ingest/upsert.ts";
import { memoryDb, tempDir } from "../helpers.ts";
import { fakeProviders, harness } from "../router-helpers.ts";

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

const doc = (text: string) => {
  const { text: t, blocks } = markdownBlocks(text);
  return upsertDocument(db, {
    parsed: {
      title: "Call with Dana",
      sourceType: "markdown",
      text: t,
      units: [{ anchor: { kind: "text" }, start: 0, end: t.length, blocks }],
    },
    externalId: `d-${text.length}`,
  }).documentId;
};

describe("memory files", () => {
  it("round-trips facts with provenance, and a quote can't break out of its comment", () => {
    const line = factLine("Dana prefers annual billing", {
      by: "source",
      doc: "d1",
      title: "Call",
      quote: "annual --> please",
      at: 1,
    });
    expect(line).not.toMatch(/annual -->/);
    expect(parseFacts(`# People\n\n${line}\n- A plain fact without provenance\n`)).toEqual([
      {
        text: "Dana prefers annual billing",
        provenance: { by: "source", doc: "d1", title: "Call", quote: "annual -- > please", at: 1 },
      },
      { text: "A plain fact without provenance", provenance: null },
    ]);
  });

  it("only allows the four kinds of file, never a path outside the folder", () => {
    for (const bad of [
      "../rocky.yaml",
      "people/../../x.md",
      "notes.md",
      "people/Dana.md",
      "C:/x.md",
      "projects/a/b.md",
    ])
      expect(() => checkPath(bad), bad).toThrow(MemoryError);
    expect(checkPath("people\\dana-lee.md")).toBe("people/dana-lee.md");
  });

  it("user facts are written, versioned in git, forgotten, and exported without history", () => {
    rememberUserFact(db, dir, "preferences.md", "Short answers first", 1);
    rememberUserFact(db, dir, "preferences.md", "Metric units", 2);
    const f = listMemory(dir)[0];
    expect(f).toMatchObject({ path: "preferences.md", group: "Preferences", title: "Preferences" });
    expect(f?.facts.map((x) => [x.text, x.provenance?.by])).toEqual([
      ["Short answers first", "user"],
      ["Metric units", "user"],
    ]);
    forgetFact(db, dir, "preferences.md", 0);
    expect(listMemory(dir)[0]?.facts.map((x) => x.text)).toEqual(["Metric units"]);
    expect(memoryHistory(dir, "preferences.md").map((v) => v.message)).toEqual([
      "Forgotten by you",
      "Noted by you",
      "Noted by you",
    ]);
    const out = tempDir();
    expect(exportMemory(dir, out).map((p) => path.relative(out, p))).toEqual(["preferences.md"]);
    expect(fs.existsSync(path.join(out, ".git"))).toBe(false);
    const audit = db
      .prepare("select count(*) as n from audit_log where event_type = 'memory_changed'")
      .get() as { n: number };
    expect(audit.n).toBe(3);
  });

  it('an edit made from a stale copy is refused with the current text ("This file changed")', () => {
    rememberUserFact(db, dir, "about-you.md", "Lives in Lisbon", 1);
    const opened = readMemoryContent(dir, "about-you.md");
    rememberUserFact(db, dir, "about-you.md", "Works at a roastery", 2);
    try {
      saveMemoryFile(
        db,
        dir,
        "about-you.md",
        `${opened.content}- typed in the editor\n`,
        opened.hash,
      );
      throw new Error("should have conflicted");
    } catch (e) {
      expect((e as MemoryError).code).toBe("CONFLICT");
      expect((e as MemoryError).current).toContain("Works at a roastery");
    }
    const fresh = readMemoryContent(dir, "about-you.md");
    expect(
      saveMemoryFile(db, dir, "about-you.md", `${fresh.content}- typed again\n`, fresh.hash).facts,
    ).toHaveLength(3);
  });
});

describe("memory proposals", () => {
  const world = () => {
    const registry = new ActionRegistry();
    registry.register(memoryAddAction(db, dir));
    return new ActionService(db, registry);
  };

  it("are drafts until approved; approving saves the fact with its quote and source", async () => {
    const svc = world();
    const id = doc("Dana said she only signs annual contracts.");
    const chunk = db.prepare("select id from chunks where document_id = ?").get(id) as {
      id: string;
    };
    const a = svc.propose({
      type: MEMORY_ADD,
      payload: {
        file: "people/dana.md",
        fact: "Dana only signs annual contracts",
        documentId: id,
        quote: "she only signs annual contracts",
      },
      origin: "user_turn",
      citations: [
        {
          chunkId: chunk.id,
          documentId: id,
          title: "Call with Dana",
          anchor: { kind: "text" },
          quote: "she only signs annual contracts",
        },
      ],
    });
    expect(a.status).toBe("draft");
    expect(listMemory(dir)).toEqual([]);
    svc.approve(a.id, a.payloadHash);
    expect((await svc.execute(a.id)).status).toBe("executed");
    const f = listMemory(dir)[0];
    expect(f?.facts[0]).toMatchObject({
      text: "Dana only signs annual contracts",
      provenance: { by: "source", doc: id, quote: "she only signs annual contracts" },
    });
  });

  it("a fact whose quote is no longer in the source is not saved (no inference stored as fact)", async () => {
    const svc = world();
    const id = doc("Dana said she prefers monthly billing for now.");
    const chunk = db.prepare("select id from chunks where document_id = ?").get(id) as {
      id: string;
    };
    const a = svc.propose({
      type: MEMORY_ADD,
      payload: {
        file: "people/dana.md",
        fact: "Dana prefers annual billing",
        documentId: id,
        quote: "she prefers annual billing",
      },
      origin: "user_turn",
      citations: [
        { chunkId: chunk.id, documentId: id, title: "x", anchor: { kind: "text" }, quote: "q" },
      ],
    });
    svc.approve(a.id, a.payloadHash, { acknowledgeSources: true });
    const r = await svc.execute(a.id);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/quote isn't in the source/);
    expect(listMemory(dir)).toEqual([]);
  });

  it("suggestions without an exact quote are dropped; the rest are proposed, never saved directly", async () => {
    const svc = world();
    const id = doc("# Call\n\nDana only signs annual contracts. She is based in Porto.");
    const { fetch } = fakeProviders(() => ({
      facts: [
        {
          file: "people/dana.md",
          fact: "Dana only signs annual contracts",
          chunkRef: "c1",
          quote: "Dana only signs annual contracts",
        },
        {
          file: "people/dana.md",
          fact: "Dana is a decision maker",
          chunkRef: "c1",
          quote: "Dana decides everything",
        },
        { file: "../rocky.yaml", fact: "x", chunkRef: "c1", quote: "She is based in Porto" },
      ],
    }));
    const h = harness(db, fetch);
    const r = await suggestMemories({ db, router: h.router, actions: svc }, id);
    expect(r.proposed.map((p) => p.payload)).toEqual([
      {
        file: "people/dana.md",
        fact: "Dana only signs annual contracts",
        documentId: id,
        quote: "Dana only signs annual contracts",
      },
    ]);
    expect(r.dropped.map((d) => d.fact)).toEqual(["Dana is a decision maker", "x"]);
    expect(listMemory(dir)).toEqual([]);
  });
});

import fs from "node:fs";
import path from "node:path";
import type { ArchiveImportResult, ArchiveImportRow } from "@rocky/contracts";
import { memorySecrets, openRuntime, type Runtime } from "@rocky/core";
import { zipSync } from "fflate";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../../../packages/core/test/helpers.ts";
import { HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";

const PORT = 7337;
const TOKEN = "t".repeat(64);
const fixtures = path.resolve(import.meta.dirname, "../../../packages/importers/test/fixtures");

let dir: string;
let rt: Runtime;
let app: Hono;

const call = async <T = unknown>(p: string, init: RequestInit = {}) => {
  const res = await app.request(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    ...init,
    headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
  return { status: res.status, body: (await res.json()) as T };
};

beforeEach(async () => {
  dir = tempDir();
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets(),
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
  });
  app = createApp({
    rt,
    auth: new Auth({ token: TOKEN, port: PORT }),
    deleteEverything: async () => {},
  });
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const anchors = (connectorId: string) =>
  (
    rt.db
      .prepare(
        "select c.anchor from chunks c join documents d on d.id = c.document_id where d.connector_id = ?",
      )
      .all(connectorId) as { anchor: string }[]
  ).map((r) => JSON.parse(r.anchor) as { kind: string; messageId?: string });

describe("archive import API", () => {
  it.each([
    ["whatsapp", "whatsapp/WhatsApp Chat with Sam Rivera.txt"],
    ["discord", "discord"],
    ["instagram", "instagram"],
    ["x", "x"],
    ["linkedin", "linkedin"],
  ])("imports the %s fixture as documents with message-id anchors", async (format, rel) => {
    const r = await call<ArchiveImportResult>("/imports/archive/path", {
      method: "POST",
      body: JSON.stringify({ path: path.join(fixtures, rel) }),
    });
    expect(r.status).toBe(201);
    expect(r.body.format).toBe(format);
    expect(r.body.added).toBe(r.body.documents);
    const a = anchors(`import:${format}`);
    expect(a.length).toBeGreaterThan(0);
    expect(a.filter((x) => x.kind === "message").every((x) => x.messageId)).toBe(true);
    expect(a.some((x) => x.kind === "message")).toBe(true);
    // Embedding is queued for every new document.
    const queued = rt.db
      .prepare("select count(*) as n from jobs where type = 'embed_document'")
      .get() as { n: number };
    expect(queued.n).toBe(r.body.documents);
  });

  it("re-importing is idempotent, and an import can be listed and removed", async () => {
    const body = JSON.stringify({ path: path.join(fixtures, "discord") });
    await call("/imports/archive/path", { method: "POST", body });
    const again = await call<ArchiveImportResult>("/imports/archive/path", {
      method: "POST",
      body,
    });
    expect(again.body).toMatchObject({ added: 0, updated: 0, unchanged: 3 });

    const list = await call<{ imports: ArchiveImportRow[] }>("/imports/archives");
    expect(list.body.imports).toEqual([
      expect.objectContaining({ format: "discord", archive: "discord", documents: 3, messages: 4 }),
    ]);
    const del = await call<{ documents: number }>("/imports/archives/discord?archive=discord", {
      method: "DELETE",
    });
    expect(del.body.documents).toBe(3);
    expect((await call<{ imports: unknown[] }>("/imports/archives")).body.imports).toEqual([]);
  });

  it("accepts a streamed zip upload and skips media inside it", async () => {
    const zip = zipSync({
      "_chat.txt": fs.readFileSync(path.join(fixtures, "whatsapp", "_chat.txt")),
      "00000002-VIDEO.mp4": new Uint8Array(4096),
    });
    const r = await call<ArchiveImportResult>(
      `/imports/archive?filename=${encodeURIComponent("WhatsApp Chat - Anna Becker.zip")}`,
      { method: "POST", body: zip },
    );
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ format: "whatsapp", archive: "WhatsApp Chat - Anna Becker" });
    const titles = rt.db.prepare("select title from documents order by title").all();
    expect(titles).toEqual([
      { title: "WhatsApp · Anna Becker · 2024-12" },
      { title: "WhatsApp · Anna Becker · 2025-01" },
    ]);
  });

  it("names unrecognized files with a 422", async () => {
    const r = await call<{ error: string; code: string }>("/imports/archive?filename=notes.txt", {
      method: "POST",
      body: "hello there\n",
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("UNRECOGNIZED_ARCHIVE");
    expect(r.body.error).toContain("notes.txt");
  });
});

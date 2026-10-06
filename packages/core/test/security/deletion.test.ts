import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit } from "../../src/audit/append.ts";
import { verifyAuditChain } from "../../src/audit/verify.ts";
import { finishRecording, startRecording, writeChunk } from "../../src/capture/recordings.ts";
import { transcribeMeeting } from "../../src/capture/transcribe-job.ts";
import { deleteData, deleteEverything } from "../../src/deletion/service.ts";
import type { Db } from "../../src/index.ts";
import { migrate, openDb } from "../../src/index.ts";
import { embedDocument } from "../../src/ingest/embed-job.ts";
import { ingestFile } from "../../src/ingest/ingest-file.ts";
import { getJob } from "../../src/jobs/queue.ts";
import { memorySecrets } from "../../src/secrets/keychain.ts";
import { blobPath } from "../../src/store/blobs.ts";
import type { ProcessRunner } from "../../src/system/exec.ts";
import { fakeEmbedder, memoryDb, tempDir } from "../helpers.ts";

// Acceptance (d) and SECURITY.md "Deletion is complete".

let db: Db;
let dir: string;
let blobs: string;
const embedder = fakeEmbedder();

/** A document with every kind of derived row pointing at it. */
async function seedDoc(name: string, body: string, connectorId?: string) {
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, body);
  const r = await ingestFile(db, blobs, file);
  if (r.status === "skipped") throw new Error("seed skipped");
  const id = r.documentId;
  if (connectorId)
    db.prepare("update documents set connector_id = ? where id = ?").run(connectorId, id);
  await embedDocument(db, embedder, id);
  const chunks = db.prepare("select id, seq from chunks where document_id = ?").all(id) as {
    id: string;
    seq: number;
  }[];
  const c0 = chunks[0]?.id ?? "";
  const now = 1;
  db.prepare(
    "insert or ignore into entities (id, kind, display_name) values ('e1', 'person', 'Sam')",
  ).run();
  db.prepare(
    "insert into document_entities (document_id, entity_id, role) values (?, 'e1', 'author')",
  ).run(id);
  db.prepare(
    "insert into summaries (id, level, document_id, text, child_chunk_ids, created_at) values (?, 'document', ?, 'summary', ?, ?)",
  ).run(`s-${id}`, id, JSON.stringify([c0]), now);
  db.prepare(
    `insert into commitments (id, text, status, source_document_id, anchor, evidence_quote, created_at, updated_at)
     values (?, 'Sam sends the deck', 'open', ?, '{}', 'sends the deck', ?, ?)`,
  ).run(`c-${id}`, id, now, now);
  db.prepare(
    "insert into decisions (id, text, source_document_id, anchor, evidence_quote, created_at) values (?, 'Drop free tier', ?, '{}', 'drop', ?)",
  ).run(`d-${id}`, id, now);
  appendAudit(db, {
    eventType: "ingested",
    actor: "system",
    subjectType: "document",
    subjectId: id,
    payload: { title: name, excerpt: body.slice(0, 40) },
  });
  return { id, chunkIds: chunks.map((c) => c.id), seqs: chunks.map((c) => c.seq) };
}

function seedNotebook(id: string, docIds: string[], chunkIds: string[]) {
  db.prepare("insert into notebooks (id, name, kind, created_at) values (?, ?, 'course', 1)").run(
    id,
    id,
  );
  for (const d of docIds)
    db.prepare(
      "insert into notebook_sources (notebook_id, document_id, added_by) values (?, ?, 'manual')",
    ).run(id, d);
  db.prepare(
    "insert into cards (id, notebook_id, front, back, source_chunk_id) values (?, ?, 'Q', 'A', ?)",
  ).run(`card-${id}`, id, chunkIds[0] ?? null);
  db.prepare(
    "insert into summaries (id, level, notebook_id, text, child_chunk_ids, created_at) values (?, 'notebook', ?, 'rollup', ?, 1)",
  ).run(`ns-${id}`, id, JSON.stringify(chunkIds));
}

/**
 * Every row of every table (except the append-only audit log, which may keep IDs) is scanned for
 * any of the given strings; the FTS and vec indexes are checked by their integer keys.
 */
function remnants(needles: string[], seqs: number[]): string[] {
  const found: string[] = [];
  const tables = (
    db
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'chunks_fts%' and name not like 'chunks_vec%' and name <> 'audit_log'",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  for (const t of tables)
    for (const row of db.prepare(`select * from "${t}"`).all()) {
      const s = JSON.stringify(row);
      for (const n of needles) if (s.includes(n)) found.push(`${t}: ${n}`);
    }
  for (const seq of seqs) {
    if (db.prepare("select 1 from chunks_fts where rowid = ?").get(seq))
      found.push(`chunks_fts: ${seq}`);
    if (db.prepare("select 1 from chunks_vec where chunk_seq = ?").get(BigInt(seq)))
      found.push(`chunks_vec: ${seq}`);
  }
  return found;
}

const auditMentions = (id: string) =>
  (
    db
      .prepare("select event_type, payload_hash from audit_log where meta like ? or subject_id = ?")
      .all(`%${id}%`, id) as { event_type: string; payload_hash: string | null }[]
  ).map((r) => r.event_type);

beforeEach(() => {
  db = memoryDb();
  dir = tempDir();
  blobs = path.join(dir, ".blobs");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("deletion leaves nothing behind", () => {
  it("documents: every derived row, index entry, blob, job and audit payload is gone", async () => {
    const a = await seedDoc(
      "alpha",
      "# Alpha\n\nSam sends the deck on Friday.\n\nWe drop the free tier.",
    );
    const b = await seedDoc("beta", "# Beta\n\nUnrelated note that must survive.");
    seedNotebook("nb1", [a.id, b.id], a.chunkIds);
    const blob = db.prepare("select blob_hash from documents where id = ?").get(a.id) as {
      blob_hash: string;
    };
    const before = remnants([a.id, ...a.chunkIds], a.seqs);
    expect(before.length).toBeGreaterThan(8);

    const report = deleteData(db, blobs, { documentIds: [a.id] });
    expect(report).toMatchObject({ documents: 1, cards: 1, blobs: 1, auditPayloads: 1 });
    expect(remnants([a.id, ...a.chunkIds], a.seqs)).toEqual([]);
    expect(fs.existsSync(blobPath(blobs, blob.blob_hash))).toBe(false);
    // The audit log keeps only events about the document, never its content.
    expect(auditMentions(a.id)).toEqual(["ingested", "deleted"]);
    expect(verifyAuditChain(db).ok).toBe(true);

    // The other document is untouched.
    expect(remnants([b.id], b.seqs).length).toBeGreaterThan(0);
    expect(db.prepare("select count(*) as n from chunks where document_id = ?").get(b.id)).toEqual({
      n: expect.any(Number),
    });
  });

  it("connector: all of its documents and the connector itself", async () => {
    db.prepare(
      "insert into connectors (id, kind, display_name, created_at) values ('gh', 'github', 'GitHub', 1)",
    ).run();
    const a = await seedDoc("issue", "# Issue 142\n\nLogin bug.", "gh");
    const b = await seedDoc("local", "# Local\n\nKeep me.");
    const report = deleteData(db, blobs, { connectorId: "gh" });
    expect(report.documents).toBe(1);
    expect(remnants([a.id, ...a.chunkIds, '"gh"'], a.seqs)).toEqual([]);
    expect(db.prepare("select count(*) as n from documents").get()).toEqual({ n: 1 });
    expect(remnants([b.id], []).length).toBeGreaterThan(0);
  });

  it("notebook with sources: deletes its own sources and keeps ones another notebook uses", async () => {
    const own = await seedDoc("own", "# Own\n\nOnly in the first notebook.");
    const shared = await seedDoc("shared", "# Shared\n\nIn both notebooks.");
    seedNotebook("nb1", [own.id, shared.id], own.chunkIds);
    seedNotebook("nb2", [shared.id], shared.chunkIds);
    const report = deleteData(db, blobs, { notebookId: "nb1", withSources: true });
    expect(report).toMatchObject({ documents: 1, keptShared: 1 });
    expect(remnants([own.id, ...own.chunkIds, "nb1"], own.seqs)).toEqual([]);
    expect(db.prepare("select notebook_id from notebook_sources").all()).toEqual([
      { notebook_id: "nb2" },
    ]);
  });

  it("notebook without sources: removes the notebook, its cards and summaries, keeps documents", async () => {
    const d = await seedDoc("doc", "# Doc\n\nStays.");
    seedNotebook("nb1", [d.id], d.chunkIds);
    deleteData(db, blobs, { notebookId: "nb1" });
    expect(remnants(["nb1"], [])).toEqual([]);
    expect(db.prepare("select count(*) as n from documents").get()).toEqual({ n: 1 });
  });

  it("everything: DB files, backups, blobs, eval DBs and keychain entries", () => {
    const data = tempDir();
    const file = path.join(data, "rocky.db");
    const fileDb = openDb(file);
    migrate(fileDb);
    fileDb.close();
    for (const d of ["backups", "blobs/ab", "evals", "rec/01ABC/mic"])
      fs.mkdirSync(path.join(data, d), { recursive: true });
    fs.writeFileSync(path.join(data, "rocky.yaml"), "localOnly: true\n");
    const secrets = memorySecrets({
      anthropic: "sk-ant-x",
      "daemon-token": "t",
      "github.token": "ghp_x",
    });
    const { removed } = deleteEverything(data, secrets);
    expect(removed.some((r) => r.endsWith("rocky.db"))).toBe(true);
    expect(fs.readdirSync(data)).toEqual(["rocky.yaml"]);
    expect(secrets.has("anthropic")).toBe(false);
    expect(secrets.has("daemon-token")).toBe(false);
    expect(secrets.list()).toEqual([]);
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("meeting: segments, transcript chunks, audio blob, recording files, jobs and auto-created people", async () => {
    const dirs = { rec: path.join(dir, "rec"), blobs };
    const consent = { participantsInformed: true, lawsAck: true } as const;
    const { meetingId, documentId } = startRecording(db, { kind: "meeting", consent });
    const pcm = Buffer.alloc(32_000, 1);
    writeChunk(db, dirs, meetingId, "mic", 0, pcm);
    writeChunk(db, dirs, meetingId, "system", 0, pcm);
    const { jobId } = await finishRecording(db, dirs, meetingId);
    // Fake whisper: one line per channel.
    const run: ProcessRunner = async (_cmd, args) => {
      const wav = args[args.indexOf("-f") + 1] as string;
      const text = wav.endsWith("mic.wav")
        ? "I will mail Dana the secret pricing"
        : "Thanks, Dana here";
      fs.writeFileSync(
        `${args[args.indexOf("-of") + 1]}.json`,
        JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1500 }, text }] }),
      );
      return { code: 0, stderrTail: "" };
    };
    await transcribeMeeting(
      {
        db,
        blobsDir: blobs,
        recDir: dirs.rec,
        whisper: () => ({ binary: "w", model: "m", threads: 1, language: "en" }),
        ffmpeg: async () => null,
        run,
      },
      { ...(getJob(db, jobId) as NonNullable<ReturnType<typeof getJob>>), attempts: 1 },
    );
    await embedDocument(db, embedder, documentId);
    db.prepare(
      "insert into entities (id, kind, display_name, unconfirmed) values ('dana', 'person', 'Dana', 1)",
    ).run();
    db.prepare(
      "insert into entities (id, kind, display_name, unconfirmed) values ('kept', 'person', 'Confirmed Person', 0)",
    ).run();
    db.prepare(
      "insert into document_entities (document_id, entity_id, role) values (?, 'dana', 'mentioned')",
    ).run(documentId);
    db.prepare(
      `insert into commitments (id, text, owner_entity_id, status, source_document_id, anchor, evidence_quote, created_at, updated_at)
       values ('cm', 'Mail Dana the pricing', 'dana', 'open', ?, '{}', 'mail Dana', 1, 1)`,
    ).run(documentId);
    // A second, still-recording meeting has chunks on disk.
    const live = startRecording(db, { kind: "meeting", consent });
    writeChunk(db, dirs, live.meetingId, "mic", 0, pcm);

    const audio = (
      db.prepare("select audio_blob from meetings where id = ?").get(meetingId) as {
        audio_blob: string;
      }
    ).audio_blob;
    const seqs = (
      db.prepare("select seq from chunks where document_id = ?").all(documentId) as {
        seq: number;
      }[]
    ).map((r) => r.seq);
    expect(remnants(["secret pricing"], seqs).length).toBeGreaterThan(0);

    const report = deleteData(db, blobs, { meetingId }, { recDir: dirs.rec });
    expect(report).toMatchObject({ documents: 1, meetings: 1, blobs: 1, entities: 1 });
    expect(remnants([meetingId, documentId, "secret pricing", "Dana", audio], seqs)).toEqual([]);
    expect(fs.existsSync(blobPath(blobs, audio))).toBe(false);
    expect(db.prepare("select id from entities").all()).toEqual(
      expect.arrayContaining([{ id: "kept" }]),
    );
    expect(verifyAuditChain(db).ok).toBe(true);
    expect(auditMentions(meetingId)).toEqual(["recording_consent", "deleted"]);

    deleteData(db, blobs, { meetingId: live.meetingId }, { recDir: dirs.rec });
    expect(fs.existsSync(path.join(dirs.rec, live.meetingId))).toBe(false);
    expect(() => writeChunk(db, dirs, live.meetingId, "mic", 1, pcm)).toThrow(/not found/);
  });
});

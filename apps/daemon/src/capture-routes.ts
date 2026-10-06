import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  ChannelSchema,
  CommitmentCreateSchema,
  CommitmentPatchSchema,
  CommitmentStatusSchema,
  EntityMergeSchema,
  type JobEvent,
  MediaImportPathSchema,
  MeetingKindSchema,
  RecordingStartSchema,
} from "@rocky/contracts";
import {
  activeRecordings,
  appendAudit,
  createCommitment,
  deleteData,
  finishRecording,
  getJob,
  getMeetingDetail,
  importMedia,
  isMediaFile,
  listCommitments,
  listDecisions,
  listEntities,
  listMeetings,
  MAX_CHUNK_BYTES,
  mergeEntities,
  type Runtime,
  retryMeeting,
  startRecording,
  updateCommitment,
  writeChunk,
} from "@rocky/core";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";

/** A browser upload of a 3-hour lecture video stays well under this. */
export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;

type Body = <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) => Promise<T>;

const bad = (message: string) => Object.assign(new Error(message), { code: "BAD_REQUEST" });

/** Phase 3 routes: recordings, media import, meetings, jobs, commitments, decisions, entities. */
export function registerCaptureRoutes(
  api: Hono,
  { rt, poke, body }: { rt: Runtime; poke?: (() => void) | undefined; body: Body },
): void {
  const dirs = { rec: rt.paths.rec, blobs: rt.paths.blobs };

  // --- Recordings ---
  api.post("/recordings", async (c) => {
    const input = await body(c, RecordingStartSchema);
    const { meetingId } = startRecording(rt.db, input);
    return c.json({ id: meetingId }, 201);
  });
  api.get("/recordings/active", (c) => c.json({ recordings: activeRecordings(rt.db) }));
  api.put(
    "/recordings/:id/chunks/:n",
    bodyLimit({
      maxSize: MAX_CHUNK_BYTES,
      onError: (c) => c.json({ error: "Chunk too large", code: "BAD_REQUEST" }, 413),
    }),
    async (c) => {
      const channel = ChannelSchema.exclude(["mixed"]).safeParse(c.req.query("channel"));
      if (!channel.success) throw bad("channel must be mic or system");
      const n = Number(c.req.param("n"));
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      writeChunk(rt.db, dirs, c.req.param("id"), channel.data, n, bytes);
      return c.body(null, 204);
    },
  );
  api.post("/recordings/:id/stop", async (c) => {
    const r = await finishRecording(rt.db, dirs, c.req.param("id"));
    poke?.();
    return c.json(r);
  });

  // --- Media import ---
  // The browser streams the raw file (no multipart buffering); ?filename= carries the name.
  api.post("/imports/media", async (c) => {
    const filename = path.basename(c.req.query("filename") ?? "");
    if (!filename || !isMediaFile(filename))
      throw bad("filename must name an audio or video file (mp3, m4a, wav, mp4, …)");
    const kind = MeetingKindSchema.catch("lecture").parse(c.req.query("kind"));
    const title = c.req.query("title")?.trim().slice(0, 200) || undefined;
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES) throw bad("File is larger than 4 GB");
    const stream = c.req.raw.body;
    if (!stream) throw bad("empty upload");
    const uploads = path.join(rt.paths.rec, "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    const tmp = path.join(uploads, `${randomUUID()}${path.extname(filename).toLowerCase()}`);
    let size = 0;
    try {
      const src = Readable.fromWeb(stream as WebReadableStream);
      src.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) src.destroy(bad("File is larger than 4 GB"));
      });
      await pipeline(src, fs.createWriteStream(tmp));
      if (size === 0) throw bad("empty upload");
      const r = await importMedia(rt.db, rt.paths.blobs, {
        file: tmp,
        filename,
        kind,
        title,
        move: true,
      });
      poke?.();
      return c.json(r, 201);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
  // A file already on this machine (CLI `rocky import`): nothing is uploaded or copied twice.
  api.post("/imports/media/path", async (c) => {
    const input = await body(c, MediaImportPathSchema);
    if (!fs.existsSync(input.path) || !fs.statSync(input.path).isFile())
      return c.json({ error: `No such file: ${input.path}`, code: "NOT_FOUND" }, 404);
    const r = await importMedia(rt.db, rt.paths.blobs, {
      file: input.path,
      kind: input.kind,
      title: input.title,
      notebookId: input.notebookId,
    });
    poke?.();
    return c.json(r, 201);
  });

  // --- Meetings ---
  api.get("/meetings", (c) => {
    const before = c.req.query("before");
    return c.json({
      meetings: listMeetings(rt.db, before ? { before: Number(before) } : {}),
    });
  });
  api.get("/meetings/:id", (c) => c.json(getMeetingDetail(rt.db, c.req.param("id"))));
  api.post("/meetings/:id/retry", (c) => {
    const r = retryMeeting(rt.db, c.req.param("id"), (id) =>
      fs.existsSync(path.join(rt.paths.rec, id)),
    );
    poke?.();
    return c.json(r);
  });
  api.delete("/meetings/:id", (c) => {
    const r = deleteData(
      rt.db,
      rt.paths.blobs,
      { meetingId: c.req.param("id") },
      { recDir: rt.paths.rec },
    );
    return r.documents ? c.json(r) : c.json({ error: "meeting not found", code: "NOT_FOUND" }, 404);
  });

  // --- Job progress (SSE). Polls the job row; ends when the job finishes or the client leaves. ---
  api.get("/jobs/:id/events", (c) => {
    const id = c.req.param("id");
    const read = (): JobEvent | null => {
      const row = rt.db
        .prepare(
          "select id, type, status, progress, progress_note, last_error from jobs where id = ?",
        )
        .get(id) as
        | {
            id: string;
            type: string;
            status: JobEvent["status"];
            progress: number | null;
            progress_note: string | null;
            last_error: string | null;
          }
        | undefined;
      return row
        ? {
            id: row.id,
            type: row.type,
            status: row.status,
            progress: row.progress,
            note: row.progress_note,
            error: row.last_error,
          }
        : null;
    };
    if (!read()) return c.json({ error: "job not found", code: "NOT_FOUND" }, 404);
    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      let last = "";
      while (!aborted) {
        const ev = read();
        if (!ev) break;
        const s = JSON.stringify(ev);
        if (s !== last)
          await stream.writeSSE({
            event: ev.status === "running" || ev.status === "queued" ? "progress" : ev.status,
            data: s,
          });
        last = s;
        if (ev.status === "done" || ev.status === "failed") break;
        await stream.sleep(1000);
      }
    });
  });
  api.get("/jobs/:id", (c) => {
    const job = getJob(rt.db, c.req.param("id"));
    return job
      ? c.json({ id: job.id, type: job.type, status: job.status, lastError: job.lastError })
      : c.json({ error: "job not found", code: "NOT_FOUND" }, 404);
  });

  // --- Commitments, decisions, entities ---
  api.get("/commitments", (c) => {
    const status = c.req.query("status");
    const parsed = status ? CommitmentStatusSchema.safeParse(status) : null;
    if (parsed && !parsed.success) throw bad("unknown status");
    const num = (k: string) => {
      const v = c.req.query(k);
      if (v === undefined || v === "") return undefined;
      if (!/^\d+$/.test(v)) throw bad(`${k} must be ms since epoch`);
      return Number(v);
    };
    return c.json({
      commitments: listCommitments(rt.db, {
        status: parsed?.data,
        ownerEntityId: c.req.query("owner") || undefined,
        dueBefore: num("due_before"),
        dueAfter: num("due_after"),
      }),
    });
  });
  api.post("/commitments", async (c) =>
    c.json(createCommitment(rt.db, await body(c, CommitmentCreateSchema)), 201),
  );
  api.patch("/commitments/:id", async (c) =>
    c.json(updateCommitment(rt.db, c.req.param("id"), await body(c, CommitmentPatchSchema))),
  );
  api.get("/decisions", (c) =>
    c.json({
      decisions: listDecisions(rt.db, {
        q: c.req.query("q") || undefined,
        ownerEntityId: c.req.query("owner") || undefined,
      }),
    }),
  );
  api.get("/entities", (c) => c.json({ entities: listEntities(rt.db, c.req.query("q") ?? "") }));
  api.post("/entities/:id/merge", async (c) => {
    const { into } = await body(c, EntityMergeSchema);
    const drop = c.req.param("id");
    const exists = rt.db
      .prepare("select count(*) as n from entities where id in (?, ?)")
      .get(into, drop) as { n: number };
    if (exists.n < 2 || into === drop)
      return c.json({ error: "entity not found", code: "NOT_FOUND" }, 404);
    rt.db.transaction(() => {
      mergeEntities(rt.db, into, drop);
      appendAudit(rt.db, {
        eventType: "entities_merged",
        actor: "user",
        subjectType: "entity",
        subjectId: into,
        meta: { merged: drop },
      });
    })();
    return c.json({ merged: drop, into });
  });
}

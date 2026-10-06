import fs from "node:fs";
import path from "node:path";
import type { Commitment, Entity, MeetingDetail } from "@rocky/contracts";
import {
  memorySecrets,
  openRuntime,
  type ProcessRunner,
  type Runtime,
  wavHeader,
} from "@rocky/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEmbedder, tempDir } from "../../../packages/core/test/helpers.ts";
import { fakeProviders, HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";

const PORT = 7337;
const TOKEN = "t".repeat(64);
const H = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` };

let dir: string;
let rt: Runtime;
let app: Hono;

const EXTRACTION = {
  notes: "Planning.",
  commitments: [
    {
      text: "Send the budget",
      owner: "me",
      counterparty: null,
      deadline: "by Friday",
      evidenceQuote: "I'll send the budget by Friday",
      segmentRef: "s1",
      confidence: 0.9,
    },
  ],
  decisions: [],
  entities: [],
};

/** Fake whisper: the mic says one line, the system another. Fake ffmpeg writes a 2 s WAV. */
const tools: ProcessRunner = async (cmd, args) => {
  if (cmd === "ffmpeg") {
    fs.writeFileSync(
      args.at(-1) as string,
      Buffer.concat([wavHeader(64_000), Buffer.alloc(64_000)]),
    );
    return { code: 0, stderrTail: "" };
  }
  const wav = args[args.indexOf("-f") + 1] as string;
  const text = wav.endsWith("mic.wav") ? "I'll send the budget by Friday." : "Sounds good to me.";
  const at = wav.endsWith("mic.wav") ? 0 : 3000;
  fs.writeFileSync(
    `${args[args.indexOf("-of") + 1]}.json`,
    JSON.stringify({ transcription: [{ offsets: { from: at, to: at + 2500 }, text }] }),
  );
  return { code: 0, stderrTail: "" };
};

function fakeFetch() {
  const emb = fakeEmbedder();
  const models = fakeProviders((_p, body) =>
    JSON.stringify(body).includes("You summarise")
      ? { title: "Budget sync", summary: "Budget talk.", topics: [], openQuestions: [] }
      : EXTRACTION,
  );
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/embed")) {
      const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ embeddings: (await emb.embed(texts, "document")).map((v) => [...v]) });
    }
    return models.fetch(input, init);
  }) as typeof globalThis.fetch;
}

beforeEach(async () => {
  dir = tempDir();
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets({ anthropic: "sk-ant-test-key-123456" }),
    fetch: fakeFetch(),
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
    run: tools,
    tools: { whisper: { binary: "whisper-cli", model: "m.bin" }, ffmpeg: "ffmpeg" },
  });
  app = createApp({ rt, auth: new Auth({ token: TOKEN, port: PORT }) });
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (p: string, init: RequestInit = {}) =>
  app.request(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    ...init,
    headers: { ...H, ...init.headers },
  });
const json = async <T = unknown>(p: string, init: RequestInit = {}) => {
  const res = await req(p, init);
  return { status: res.status, body: (await res.json()) as T };
};
const post = <T = unknown>(p: string, body?: unknown) =>
  json<T>(p, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const pcm = (ms: number) => Buffer.alloc((ms / 1000) * 32_000, 1);
const consent = { participantsInformed: true, lawsAck: true };

describe("recordings API", () => {
  it("requires both consent boxes", async () => {
    expect((await post("/recordings", { kind: "meeting" })).status).toBe(400);
    expect(
      (await post("/recordings", { kind: "meeting", consent: { ...consent, lawsAck: false } }))
        .status,
    ).toBe(400);
  });

  it("records, stops, transcribes and understands end to end", async () => {
    const { status, body } = await post<{ id: string }>("/recordings", {
      kind: "meeting",
      consent,
    });
    expect(status).toBe(201);
    const id = body.id;
    expect(
      (await json<{ recordings: { id: string }[] }>("/recordings/active")).body.recordings,
    ).toEqual([expect.objectContaining({ id })]);
    for (const channel of ["mic", "system"]) {
      const res = await req(`/recordings/${id}/chunks/0?channel=${channel}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: pcm(5000),
      });
      expect(res.status).toBe(204);
    }
    const badChannel = await req(`/recordings/${id}/chunks/1?channel=mixed`, {
      method: "PUT",
      body: pcm(10),
    });
    expect(badChannel.status).toBe(400);
    const tooBig = await req(`/recordings/${id}/chunks/1?channel=mic`, {
      method: "PUT",
      headers: { "content-length": String((1 << 20) + 2) },
      body: Buffer.alloc((1 << 20) + 2),
    });
    expect(tooBig.status).toBe(413);

    const stop = await post<{ jobId: string }>(`/recordings/${id}/stop`);
    expect(stop.status).toBe(200);
    expect((await post(`/recordings/${id}/stop`)).status).toBe(409);
    await rt.drainJobs();

    const detail = (await json<MeetingDetail>(`/meetings/${id}`)).body;
    expect(detail.meeting).toMatchObject({
      status: "done",
      title: "Budget sync",
      durationMs: 5000,
      commitmentCount: 1,
    });
    expect(detail.segments.map((s) => s.speakerLabel)).toEqual(["You", "Others"]);
    expect(detail.commitments[0]).toMatchObject({
      evidenceQuote: "I'll send the budget by Friday",
      anchor: { kind: "transcript", startMs: 0, endMs: 2500 },
      ownerName: "Me",
      meetingId: id,
    });

    // The commitment's anchor opens the transcript viewer with the audio.
    const chunk = rt.db
      .prepare("select id from chunks where document_id = ?")
      .get(detail.meeting.documentId) as { id: string };
    const anchor = await json<{ viewer: string; audioUrl: string; segments: unknown[] }>(
      `/documents/${detail.meeting.documentId}/anchor?chunk=${chunk.id}`,
    );
    expect(anchor.body).toMatchObject({
      viewer: "transcript",
      startMs: 0,
      audioUrl: detail.meeting.audioUrl,
    });
    expect(anchor.body.segments).toHaveLength(2);

    // Audio streams with range support.
    const audio = await req(`${(detail.meeting.audioUrl as string).replace("/api/v1", "")}`, {
      headers: { range: "bytes=0-43" },
    });
    expect(audio.status).toBe(206);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await audio.arrayBuffer()).toString("ascii", 0, 4)).toBe("RIFF");
    const full = await req(`${(detail.meeting.audioUrl as string).replace("/api/v1", "")}`);
    expect((await full.arrayBuffer()).byteLength).toBe(44 + 5 * 32_000);

    // Job events: a finished job reports done and closes.
    const sse = await (await req(`/jobs/${stop.body.jobId}/events`)).text();
    expect(sse).toMatch(/^event: done$/m);
  });

  it("streams a media upload into an import meeting", async () => {
    const res = await req("/imports/media?filename=lecture%2001.mp4&kind=lecture", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("fake mp4 bytes"),
    });
    expect(res.status).toBe(201);
    const { meetingId } = (await res.json()) as { meetingId: string };
    await rt.drainJobs();
    const m = (await json<MeetingDetail>(`/meetings/${meetingId}`)).body.meeting;
    expect(m).toMatchObject({
      source: "import",
      kind: "lecture",
      title: "lecture 01",
      status: "done",
    });
    expect(fs.readdirSync(path.join(rt.paths.rec, "uploads"))).toEqual([]);
    const reject = await req("/imports/media?filename=notes.exe", { method: "POST", body: "x" });
    expect(reject.status).toBe(400);
  });

  it("imports a local file path and lists meetings", async () => {
    const file = path.join(dir, "talk.mp3");
    fs.writeFileSync(file, "x");
    expect((await post("/imports/media/path", { path: file })).status).toBe(201);
    expect((await post("/imports/media/path", { path: path.join(dir, "nope.mp3") })).status).toBe(
      404,
    );
    const list = await json<{ meetings: { title: string }[] }>("/meetings");
    expect(list.body.meetings.map((m) => m.title)).toEqual(["talk"]);
  });
});

describe("commitments, decisions and entities API", () => {
  async function seeded() {
    const { body } = await post<{ id: string }>("/recordings", { kind: "meeting", consent });
    await req(`/recordings/${body.id}/chunks/0?channel=mic`, { method: "PUT", body: pcm(1000) });
    await req(`/recordings/${body.id}/chunks/0?channel=system`, { method: "PUT", body: pcm(1000) });
    await post(`/recordings/${body.id}/stop`);
    await rt.drainJobs();
    return body.id;
  }

  it("filters, edits (marking user_edited and auditing) and merges owners", async () => {
    await seeded();
    const open = (await json<{ commitments: Commitment[] }>("/commitments?status=open")).body
      .commitments;
    expect(open).toHaveLength(1);
    const c = open[0] as Commitment;
    expect((await json(`/commitments?status=bogus`)).status).toBe(400);

    const patched = await json<Commitment>(`/commitments/${c.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done", deadline: null }),
    });
    expect(patched.body).toMatchObject({ status: "done", deadline: null, userEdited: true });
    expect((await json(`/commitments/${c.id}`, { method: "PATCH", body: "{}" })).status).toBe(400);
    expect((await json("/commitments?status=open")).body).toEqual({ commitments: [] });
    const audit = rt.db
      .prepare("select meta from audit_log where event_type = 'commitment_edited'")
      .get() as { meta: string };
    expect(JSON.parse(audit.meta)).toEqual({ fields: ["status", "deadline"] });

    const manual = await post<Commitment>("/commitments", {
      text: "Book the room",
      documentId: c.documentId,
    });
    expect(manual.status).toBe(201);
    expect(manual.body).toMatchObject({ userEdited: true, status: "open" });

    const dana = (await post("/entities/x/merge", { into: "y" })).status;
    expect(dana).toBe(404);
    rt.db
      .prepare(
        "insert into entities (id, kind, display_name, unconfirmed) values ('dup', 'person', 'Myself Again', 1)",
      )
      .run();
    const me = (await json<{ entities: Entity[] }>("/entities?q=me")).body.entities[0] as Entity;
    expect((await post("/entities/dup/merge", { into: me.id })).status).toBe(200);
    expect(
      (await json<{ entities: Entity[] }>("/entities?q=again")).body.entities.map((e) => e.id),
    ).toEqual([me.id]);
    expect((await json<{ decisions: unknown[] }>("/decisions?q=x")).body.decisions).toEqual([]);
  });

  it("deletes a meeting with everything derived from it", async () => {
    const id = await seeded();
    const res = await json<{ meetings: number; blobs: number }>(`/meetings/${id}`, {
      method: "DELETE",
    });
    expect(res.body).toMatchObject({ meetings: 1, blobs: 1 });
    expect((await json(`/meetings/${id}`)).status).toBe(404);
    expect((await json<{ commitments: unknown[] }>("/commitments")).body.commitments).toEqual([]);
  });

  it("retries only failed meetings", async () => {
    const id = await seeded();
    expect((await post(`/meetings/${id}/retry`)).status).toBe(409);
    rt.db.prepare("update meetings set transcription_status = 'failed' where id = ?").run(id);
    const r = await post<{ jobId: string }>(`/meetings/${id}/retry`);
    expect(r.status).toBe(200);
    expect(rt.db.prepare("select type from jobs where id = ?").get(r.body.jobId)).toEqual({
      type: "understand_meeting",
    });
  });
});

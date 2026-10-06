import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeRecordings,
  assembleChannels,
  type Db,
  dropEchoes,
  finishRecording,
  getJob,
  getMeetingRow,
  importMedia,
  labelSegments,
  mixPcm,
  type ProcessRunner,
  parseDuration,
  parseProgress,
  parseTime,
  parseWhisperJson,
  segmentsToParsedDoc,
  startRecording,
  TRANSCRIBE_JOB,
  toWavArgs,
  transcribeMeeting,
  UNDERSTAND_JOB,
  verifyAuditChain,
  wavHeader,
  writeChunk,
} from "../src/index.ts";
import { memoryDb, tempDir } from "./helpers.ts";

let db: Db;
let dir: string;
let dirs: { rec: string; blobs: string };

beforeEach(() => {
  db = memoryDb();
  dir = tempDir();
  dirs = { rec: path.join(dir, "rec"), blobs: path.join(dir, "blobs") };
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const pcm = (samples: number[]) => {
  const b = Buffer.alloc(samples.length * 2);
  for (const [i, s] of samples.entries()) b.writeInt16LE(s, i * 2);
  return b;
};
const consent = { participantsInformed: true, lawsAck: true } as const;

describe("audio", () => {
  it("writes a canonical WAV header", () => {
    const h = wavHeader(32_000);
    expect(h.toString("ascii", 0, 4)).toBe("RIFF");
    expect(h.readUInt32LE(4)).toBe(36 + 32_000);
    expect(h.readUInt32LE(24)).toBe(16_000);
    expect(h.readUInt16LE(34)).toBe(16);
    expect(h.readUInt32LE(40)).toBe(32_000);
  });

  it("mixes with clamping and treats the shorter input as silence", () => {
    const out = mixPcm(pcm([1000, 30000, -30000]), pcm([2000, 10000]));
    expect([0, 1, 2].map((i) => out.readInt16LE(i * 2))).toEqual([3000, 32767, -30000]);
  });
});

describe("recordings", () => {
  it("logs consent to the audit chain and lists the active recording", () => {
    const { meetingId } = startRecording(db, { kind: "meeting", consent }, 1000);
    expect(activeRecordings(db).map((r) => r.id)).toEqual([meetingId]);
    const ev = db
      .prepare(
        "select event_type, subject_id from audit_log where event_type = 'recording_consent'",
      )
      .get() as { subject_id: string };
    expect(ev.subject_id).toBe(meetingId);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("validates chunks: index, size, sample alignment, state", () => {
    const { meetingId } = startRecording(db, { kind: "meeting", consent });
    expect(() => writeChunk(db, dirs, meetingId, "mic", -1, pcm([1]))).toThrow(/chunk number/);
    expect(() => writeChunk(db, dirs, meetingId, "mic", 0, Buffer.alloc((1 << 20) + 2))).toThrow(
      /too large/,
    );
    expect(() => writeChunk(db, dirs, meetingId, "mic", 0, Buffer.alloc(3))).toThrow(/16-bit/);
    expect(() => writeChunk(db, dirs, "../../etc", "mic", 0, pcm([1]))).toThrow();
  });

  it("assembles out-of-order and retried chunks, aligns channels, pads a lost chunk", () => {
    const d = path.join(dir, "asm");
    const put = (c: string, n: number, s: number[]) => {
      fs.mkdirSync(path.join(d, c), { recursive: true });
      fs.writeFileSync(path.join(d, c, `${n}.pcm`), pcm(s));
    };
    put("mic", 2, [5, 6]);
    put("mic", 0, [1, 2]);
    put("mic", 0, [1, 2]); // retried PUT
    put("system", 0, [9]);
    put("system", 2, [7, 8]);
    // chunk 1 is lost on both channels → 5 s of silence
    const r = assembleChannels(d);
    expect(r.channels).toEqual(["mic", "system"]);
    const mic = fs.readFileSync(path.join(d, "mic.pcm"));
    const sys = fs.readFileSync(path.join(d, "system.pcm"));
    expect(mic.length).toBe(sys.length);
    expect(mic.length).toBe(4 + 160_000 + 4);
    expect(sys.readInt16LE(0)).toBe(9);
    expect(sys.readInt16LE(2)).toBe(0); // padded to the mic chunk's length
    expect(mic.readInt16LE(4 + 160_000)).toBe(5);
  });

  it("stop builds the playback blob, queues transcription once, rejects late chunks", async () => {
    const { meetingId, documentId } = startRecording(db, { kind: "meeting", consent });
    writeChunk(db, dirs, meetingId, "mic", 0, pcm(new Array(16_000).fill(100)));
    writeChunk(db, dirs, meetingId, "system", 0, pcm(new Array(16_000).fill(200)));
    const { jobId } = await finishRecording(db, dirs, meetingId);
    const m = getMeetingRow(db, meetingId);
    expect(m?.transcription_status).toBe("queued");
    expect(m?.duration_ms).toBe(1000);
    expect(m?.audio_blob).toMatch(/^[0-9a-f]{64}$/);
    const doc = db.prepare("select blob_hash, mime from documents where id = ?").get(documentId);
    expect(doc).toEqual({ blob_hash: m?.audio_blob, mime: "audio/wav" });
    expect(getJob(db, jobId)?.type).toBe(TRANSCRIBE_JOB);
    expect(fs.existsSync(path.join(dirs.rec, meetingId, "mic.wav"))).toBe(true);
    await expect(finishRecording(db, dirs, meetingId)).rejects.toThrow(/already stopped/);
    expect(() => writeChunk(db, dirs, meetingId, "mic", 1, pcm([1]))).toThrow(/already stopped/);
    expect(activeRecordings(db)).toEqual([]);
  });
});

describe("whisper and ffmpeg output parsing", () => {
  it("reads progress, segments and log-probs; drops non-speech", () => {
    expect(parseProgress("whisper_print_progress_callback: progress =  40%")).toBe(0.4);
    expect(parseProgress("output_json: saving")).toBeNull();
    const segs = parseWhisperJson(
      JSON.stringify({
        transcription: [
          {
            offsets: { from: 0, to: 2000 },
            text: " Hello there.",
            tokens: [
              { text: "[_BEG_]", p: 0.9 },
              { text: " Hello", p: 0.5 },
              { text: " there", p: 0.5 },
            ],
          },
          { offsets: { from: 2000, to: 4000 }, text: " [BLANK_AUDIO]" },
          { offsets: { from: 4000, to: 5000 }, text: " (music)" },
        ],
      }),
    );
    expect(segs).toEqual([
      { startMs: 0, endMs: 2000, text: "Hello there.", avgLogprob: Math.log(0.5) },
    ]);
  });

  it("reads ffmpeg duration and time, and builds an audio-only 16 kHz command", () => {
    expect(parseDuration("  Duration: 01:00:30.50, start: 0.000000, bitrate: 128 kb/s")).toBe(
      3_630_500,
    );
    expect(parseTime("size= 1kB time=00:00:12.34 bitrate=")).toBe(12_340);
    const args = toWavArgs("in.mp4", "out.wav");
    expect(args).toEqual(expect.arrayContaining(["-vn", "-ac", "1", "-ar", "16000", "-nostdin"]));
    expect(args.at(-1)).toBe("out.wav");
  });
});

describe("labels and echo dedup", () => {
  const seg = (startMs: number, endMs: number, text: string) => ({
    startMs,
    endMs,
    text,
    avgLogprob: null,
  });

  it("drops a mic segment that overlaps a near-identical system segment", () => {
    const system = [seg(1000, 4000, "We should ship the beta on Monday")];
    const mic = [
      seg(1100, 4100, "we should ship the beta on monday"),
      seg(5000, 6000, "Sounds good, I'll write the notes"),
      seg(8000, 9000, "We should ship the beta on Monday"), // same words, no overlap: kept
    ];
    expect(dropEchoes(mic, system).map((s) => s.startMs)).toEqual([5000, 8000]);
  });

  it("labels two channels You/Others and a single channel as mixed", () => {
    const two = labelSegments({ mic: [seg(2000, 3000, "mine")], system: [seg(0, 1000, "theirs")] });
    expect(two.map((s) => [s.channel, s.speakerLabel])).toEqual([
      ["system", "Others"],
      ["mic", "You"],
    ]);
    const one = labelSegments({ mic: [seg(0, 1000, "only me")] });
    expect(one[0]).toMatchObject({ channel: "mixed", speakerLabel: "Speaker 1" });
  });

  it("windows the transcript into ≤ 60 s transcript anchors", () => {
    const segs = labelSegments({
      mixed: [seg(0, 30_000, "a"), seg(30_000, 59_000, "b"), seg(59_000, 75_000, "c")],
    });
    const doc = segmentsToParsedDoc("t", segs);
    expect(doc.units.map((u) => u.anchor)).toEqual([
      { kind: "transcript", startMs: 0, endMs: 59_000 },
      { kind: "transcript", startMs: 59_000, endMs: 75_000 },
    ]);
    expect(doc.text).toBe("a\n\nb\n\nc");
  });
});

/** A fake whisper/ffmpeg: writes canned JSON where whisper would, a WAV where ffmpeg would. */
function fakeTools(byWav: Record<string, string[]>): { run: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: ProcessRunner = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "ffmpeg") {
      opts?.onStderrLine?.("  Duration: 00:00:10.00, start: 0");
      opts?.onStderrLine?.("size=1kB time=00:00:05.00 bitrate=1");
      fs.writeFileSync(
        args.at(-1) as string,
        Buffer.concat([wavHeader(320_000), Buffer.alloc(320_000)]),
      );
      return { code: 0, stderrTail: "" };
    }
    const wav = args[args.indexOf("-f") + 1] as string;
    const texts = byWav[path.basename(wav)] ?? [];
    opts?.onStderrLine?.("whisper_print_progress_callback: progress = 50%");
    fs.writeFileSync(
      `${args[args.indexOf("-of") + 1]}.json`,
      JSON.stringify({
        transcription: texts.map((text, i) => ({
          offsets: { from: i * 2000, to: i * 2000 + 1500 },
          text,
        })),
      }),
    );
    return { code: 0, stderrTail: "" };
  };
  return { run, calls };
}

describe("transcribe job", () => {
  const deps = (run: ProcessRunner, ffmpeg: string | null = "ffmpeg") => ({
    db,
    blobsDir: dirs.blobs,
    recDir: dirs.rec,
    whisper: () => ({ binary: "whisper-cli", model: "m.bin", threads: 2, language: "en" as const }),
    ffmpeg: async () => ffmpeg,
    run,
  });
  const claim = (id: string) => ({
    ...(getJob(db, id) as NonNullable<ReturnType<typeof getJob>>),
    attempts: 1,
  });

  it("transcribes a recording into labeled segments, a meeting document, embed + understand jobs", async () => {
    const { meetingId, documentId } = startRecording(db, { kind: "meeting", consent });
    writeChunk(db, dirs, meetingId, "mic", 0, pcm(new Array(32_000).fill(1)));
    writeChunk(db, dirs, meetingId, "system", 0, pcm(new Array(32_000).fill(1)));
    const { jobId } = await finishRecording(db, dirs, meetingId);
    const tools = fakeTools({
      "mic.wav": ["I'll send the notes by Friday.", "Thanks everyone."],
      "system.wav": ["Great, then we ship Monday.", "Thanks everyone!"],
    });
    await transcribeMeeting(deps(tools.run), claim(jobId));

    const segs = db
      .prepare(
        "select speaker_label, text from transcript_segments where meeting_id = ? order by start_ms, channel",
      )
      .all(meetingId) as { speaker_label: string; text: string }[];
    // The mic's "Thanks everyone." overlaps the system copy and is dropped as echo.
    expect(segs).toEqual([
      { speaker_label: "You", text: "I'll send the notes by Friday." },
      { speaker_label: "Others", text: "Great, then we ship Monday." },
      { speaker_label: "Others", text: "Thanks everyone!" },
    ]);
    const doc = db
      .prepare("select source_type, raw_text, blob_hash from documents where id = ?")
      .get(documentId) as {
      source_type: string;
      raw_text: string;
      blob_hash: string;
    };
    expect(doc.source_type).toBe("meeting");
    expect(doc.raw_text).toContain("You: I'll send the notes by Friday.");
    const anchors = db
      .prepare("select anchor from chunks where document_id = ?")
      .all(documentId) as { anchor: string }[];
    expect(JSON.parse(anchors[0]?.anchor ?? "{}")).toMatchObject({
      kind: "transcript",
      startMs: 0,
    });
    const types = (
      db.prepare("select type from jobs where status = 'queued'").all() as { type: string }[]
    ).map((j) => j.type);
    expect(types).toEqual(expect.arrayContaining(["embed_document", UNDERSTAND_JOB]));
    const m = getMeetingRow(db, meetingId);
    expect(m?.transcription_status).toBe("understanding");
    expect(fs.existsSync(path.join(dirs.rec, meetingId))).toBe(false);
    expect(getJob(db, jobId)?.status).toBe("queued"); // the runner completes it, not the handler
  });

  it("imports media through ffmpeg as a single mixed channel", async () => {
    const src = path.join(dir, "lecture.mp4");
    fs.writeFileSync(src, "not really a video");
    const { meetingId, jobId } = await importMedia(db, dirs.blobs, { file: src, kind: "lecture" });
    expect(getMeetingRow(db, meetingId)).toMatchObject({
      source: "import",
      title: "lecture",
      transcription_status: "queued",
    });
    const tools = fakeTools({ "mixed.wav": ["Today we cover eigenvalues."] });
    await transcribeMeeting(deps(tools.run), claim(jobId));
    expect(tools.calls[0]?.[0]).toBe("ffmpeg");
    const seg = db.prepare("select channel, speaker_label from transcript_segments").get();
    expect(seg).toEqual({ channel: "mixed", speaker_label: "Speaker 1" });
    expect(getMeetingRow(db, meetingId)?.duration_ms).toBe(10_000);
    const doc = db.prepare("select mime from documents where external_id = ?").get(meetingId);
    expect(doc).toEqual({ mime: "video/mp4" });
  });

  it("fails visibly when a tool is missing, retrying until the last attempt", async () => {
    const src = path.join(dir, "talk.mp3");
    fs.writeFileSync(src, "x");
    const { meetingId, jobId } = await importMedia(db, dirs.blobs, { file: src });
    const job = claim(jobId);
    await expect(transcribeMeeting(deps(fakeTools({}).run, null), job)).rejects.toThrow(
      /ffmpeg is not installed/,
    );
    expect(getMeetingRow(db, meetingId)).toMatchObject({ transcription_status: "queued" });
    await expect(
      transcribeMeeting(deps(fakeTools({}).run, null), { ...job, attempts: 2 }),
    ).rejects.toThrow();
    expect(getMeetingRow(db, meetingId)).toMatchObject({
      transcription_status: "failed",
      error: expect.stringMatching(/rocky doctor --fix/),
    });
  });

  it("marks a silent recording done without queuing understanding", async () => {
    const { meetingId } = startRecording(db, { kind: "meeting", consent });
    writeChunk(db, dirs, meetingId, "mic", 0, pcm([0, 0]));
    const { jobId } = await finishRecording(db, dirs, meetingId);
    await transcribeMeeting(deps(fakeTools({}).run), claim(jobId));
    expect(getMeetingRow(db, meetingId)).toMatchObject({
      transcription_status: "done",
      error: "No speech was detected.",
    });
    expect(db.prepare("select count(*) n from jobs where type = ?").get(UNDERSTAND_JOB)).toEqual({
      n: 0,
    });
  });
});

describe("playback mix", () => {
  it("contains only audio samples (no channel WAV headers)", async () => {
    const { meetingId } = startRecording(db, { kind: "meeting", consent });
    writeChunk(db, dirs, meetingId, "mic", 0, pcm([100, 200]));
    writeChunk(db, dirs, meetingId, "system", 0, pcm([1, 2]));
    await finishRecording(db, dirs, meetingId);
    const blob = getMeetingRow(db, meetingId)?.audio_blob as string;
    const wav = fs.readFileSync(path.join(dirs.blobs, blob.slice(0, 2), blob));
    expect(wav.length).toBe(44 + 4);
    expect([wav.readInt16LE(44), wav.readInt16LE(46)]).toEqual([101, 202]);
  });
});

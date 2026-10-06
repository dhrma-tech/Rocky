import { AppConfigSchema, DoctorReportSchema } from "@rocky/contracts";
import { describe, expect, it } from "vitest";
import { type DoctorProbes, ramTier, runDoctor } from "../src/index.ts";

const GB = 1024 ** 3;
const config = AppConfigSchema.parse({});

function probes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    hardware: async () => ({
      platform: "win32",
      release: "10.0",
      cpu: "cpu",
      cores: 8,
      ramGb: 15.7,
      ramTier: "high",
      gpus: [],
      cuda: false,
    }),
    freeBytes: () => 100 * GB,
    vec: () => ({ ok: true, version: "v0.1.9" }),
    fts5: () => true,
    ollama: async () => ({ ok: true, version: "0.35.1", models: ["nomic-embed-text:latest"] }),
    whisper: () => ({ binary: "w.exe", model: "m.bin" }),
    ffmpeg: async () => "ffmpeg",
    whisperSpeed: async () => 2,
    keychain: () => ({ ok: true }),
    writable: () => true,
    nodeVersion: "24.11.1",
    now: () => 1,
    ...over,
  };
}
const run = (over?: Partial<DoctorProbes>) =>
  runDoctor({ dataDir: "E:RockyData", dataDirSource: "env", config }, probes(over));
const status = async (id: string, over?: Partial<DoctorProbes>) =>
  (await run(over)).checks.find((c) => c.id === id)?.status;

describe("runDoctor", () => {
  it("produces a schema-valid, all-pass report on a healthy machine", async () => {
    const r = await run();
    expect(DoctorReportSchema.parse(r)).toEqual(r);
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("warns below 10 GB free and fails without a writable data dir", async () => {
    expect(await status("disk", { freeBytes: () => 5 * GB })).toBe("warn");
    const r = await run({ writable: () => false });
    expect(r.ok).toBe(false);
  });

  it("fails when sqlite-vec does not load", async () => {
    expect(await status("sqlite-vec", { vec: () => ({ ok: false, error: "no functions" }) })).toBe(
      "fail",
    );
  });

  it("warns when Ollama is down and skips the embed check", async () => {
    const r = await run({ ollama: async () => ({ ok: false, error: "ECONNREFUSED" }) });
    expect(r.checks.find((c) => c.id === "ollama")?.status).toBe("warn");
    expect(r.checks.find((c) => c.id === "embed-model")).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("fails when the embedding model is missing", async () => {
    const r = await run({
      ollama: async () => ({ ok: true, version: "x", models: ["mistral:latest"] }),
    });
    expect(r.checks.find((c) => c.id === "embed-model")?.hint).toBe("ollama pull nomic-embed-text");
    expect(r.ok).toBe(false);
  });

  it("rejects Node older than 22.18", async () => {
    expect(await status("node", { nodeVersion: "22.11.0" })).toBe("fail");
  });

  it("maps RAM to tiers with the 15 GB tolerance", () => {
    expect([ramTier(8), ramTier(12), ramTier(15.7), ramTier(32)]).toEqual([
      "low",
      "mid",
      "high",
      "high",
    ]);
  });

  it("warns when ffmpeg is missing and only benchmarks whisper on request", async () => {
    expect(await status("ffmpeg", { ffmpeg: async () => null })).toBe("warn");
    expect((await run()).checks.some((c) => c.id === "whisper-speed")).toBe(false);
    const bench = (speed: number) =>
      runDoctor(
        { dataDir: "E:RockyData", dataDirSource: "env", config, bench: true },
        probes({ whisperSpeed: async () => speed }),
      ).then((r) => r.checks.find((c) => c.id === "whisper-speed"));
    expect(await bench(2)).toMatchObject({
      status: "pass",
      detail: expect.stringMatching(/2.00x/),
    });
    expect(await bench(0.3)).toMatchObject({ status: "warn", hint: expect.stringMatching(/base/) });
  });
});

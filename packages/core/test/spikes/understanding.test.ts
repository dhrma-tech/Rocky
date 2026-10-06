// Phase 3 acceptance #3, live: the 20 sample transcripts through the real local model.
// Records the raw Ollama replies to fixtures/understanding/recorded/ when ROCKY_RECORD=1, so CI can
// replay them (test/understanding-replay.test.ts). Skipped when Ollama or the derived model is absent.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getMeetingRow,
  hasModel,
  type Job,
  loadPolicy,
  ollamaStatus,
  understandMeeting,
} from "../../src/index.ts";
import { ProviderGate } from "../../src/router/gate.ts";
import { Router } from "../../src/router/router.ts";
import { memorySecrets } from "../../src/secrets/keychain.ts";
import { memoryDb } from "../helpers.ts";
import { HW_HIGH, PRICES } from "../router-helpers.ts";
import { RECORDED_DIR, samples, seedSample } from "../understanding-fixtures.ts";

const BASE = "http://127.0.0.1:11434";
const policy = loadPolicy(path.join(import.meta.dirname, "no-such-data-dir"));
const model = Object.keys(policy.ollama_models)[0] ?? "";
const status = await ollamaStatus(BASE);
const ready = status.ok && hasModel(status.models, model);
const only = process.env.ROCKY_SAMPLES?.split(",");

describe.skipIf(!ready)("spike: understanding on 20 sample transcripts (local)", () => {
  it(
    "produces schema-valid extractions for every sample",
    async () => {
      fs.mkdirSync(RECORDED_DIR, { recursive: true });
      const failures: string[] = [];
      for (const s of samples().filter((x) => !only || only.includes(x.id))) {
        const db = memoryDb();
        const responses: unknown[] = [];
        const recording = (async (input: string | URL | Request, init?: RequestInit) => {
          const res = await fetch(input, init);
          const body = await res.clone().json();
          responses.push(body);
          return res;
        }) as typeof fetch;
        const gate = new ProviderGate(db, {
          settings: () => ({ localOnly: true, monthlyCapUsd: 10, ollamaBaseUrl: BASE }),
          prices: () => PRICES,
          secrets: memorySecrets({}),
          fetch: recording,
        });
        const router = new Router({
          gate,
          policy: () => policy,
          hardware: () => HW_HIGH,
          globalLocalOnly: () => true,
        });
        const { meetingId, job } = seedSample(db, s);
        const t0 = performance.now();
        try {
          const r = await understandMeeting({ db, router }, job as Job);
          console.info(
            `${s.id}: ${JSON.stringify(r)} in ${((performance.now() - t0) / 1000).toFixed(0)} s`,
          );
        } catch (err) {
          failures.push(`${s.id}: ${String(err)}`);
          console.info(`${s.id}: FAILED ${String(err)}`);
        }
        if (getMeetingRow(db, meetingId)?.transcription_status !== "done")
          failures.push(`${s.id}: not done`);
        if (process.env.ROCKY_RECORD === "1")
          fs.writeFileSync(
            path.join(RECORDED_DIR, `${s.id}.json`),
            `${JSON.stringify({ model, recordedAt: new Date().toISOString().slice(0, 10), responses }, null, 1)}\n`,
          );
        db.close();
      }
      expect(failures).toEqual([]);
    },
    60 * 60_000,
  );
});

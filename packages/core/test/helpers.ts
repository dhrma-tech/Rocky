import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Db, migrate, openDb } from "../src/index.ts";
import type { Embedder } from "../src/router/embed.ts";

export function tempDir(prefix = "rocky-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function memoryDb(): Db {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

/**
 * Deterministic bag-of-words embedder: texts that share words get similar vectors.
 * Good enough for retrieval tests without Ollama.
 */
export function fakeEmbedder(dim = 768): Embedder & { calls: number } {
  const e = {
    model: "fake",
    dim,
    calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      return texts.map((t) => {
        const v = new Float32Array(dim);
        for (const word of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          const h = createHash("md5").update(word).digest();
          const i = h.readUInt16LE(0) % dim;
          v[i] = (v[i] ?? 0) + 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
  return e;
}

export const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);

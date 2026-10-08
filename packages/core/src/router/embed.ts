import { z } from "zod";

/**
 * Embeddings stay local (Ollama on loopback), so they don't pass ProviderGate's egress and budget
 * checks. If an API embedding provider is ever added, it must go through the gate instead.
 */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
}

const EmbedResponse = z.object({ embeddings: z.array(z.array(z.number())) });

/** nomic-embed-text requires task prefixes (memory.md). */
const PREFIX = { document: "search_document: ", query: "search_query: " } as const;

export function ollamaEmbedder(opts: {
  baseUrl: string;
  model?: string;
  dim?: number;
  batchSize?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Embedder {
  const model = opts.model ?? "nomic-embed-text";
  const dim = opts.dim ?? 768;
  const batch = opts.batchSize ?? 32;
  const doFetch = opts.fetch ?? fetch;
  return {
    model,
    dim,
    async embed(texts, kind) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batch) {
        const input = texts.slice(i, i + batch).map((t) => PREFIX[kind] + t);
        const res = await doFetch(new URL("/api/embed", opts.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input, truncate: true }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
        if (!res.ok)
          throw new Error(
            `Ollama /api/embed returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
          );
        const { embeddings } = EmbedResponse.parse(await res.json());
        for (const e of embeddings) {
          if (e.length !== dim)
            throw new Error(`Embedding dimension ${e.length} != expected ${dim} for ${model}`);
          out.push(Float32Array.from(e));
        }
      }
      return out;
    },
  };
}

/**
 * Remembers query embeddings (roadmap A8: cache embeddings and retrieval). Asking the same or a
 * repeated question skips the embedding call. Documents are never cached here: they are stored
 * with their chunks already.
 */
export function cachedEmbedder(inner: Embedder, max = 256): Embedder {
  const cache = new Map<string, Float32Array>();
  return {
    model: inner.model,
    dim: inner.dim,
    async embed(texts, kind) {
      if (kind !== "query") return inner.embed(texts, kind);
      const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
      if (missing.length) {
        const vecs = await inner.embed(missing, kind);
        missing.forEach((t, i) => {
          const v = vecs[i];
          if (v) cache.set(t, v);
        });
        while (cache.size > max) cache.delete(cache.keys().next().value as string);
      }
      return texts.map((t) => {
        const v = cache.get(t) as Float32Array;
        // Refresh recency: the most used questions stay.
        cache.delete(t);
        cache.set(t, v);
        return v;
      });
    },
  };
}

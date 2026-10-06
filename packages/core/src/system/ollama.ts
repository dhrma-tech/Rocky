import { z } from "zod";

const VersionSchema = z.object({ version: z.string() });
const TagsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });

export type OllamaStatus =
  | { ok: true; version: string; models: string[] }
  | { ok: false; error: string };

export async function ollamaStatus(baseUrl: string, timeoutMs = 3000): Promise<OllamaStatus> {
  try {
    const get = async (p: string) => {
      const res = await fetch(new URL(p, baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`${p} returned ${res.status}`);
      return res.json();
    };
    const [v, t] = await Promise.all([get("/api/version"), get("/api/tags")]);
    return {
      ok: true,
      version: VersionSchema.parse(v).version,
      models: TagsSchema.parse(t).models.map((m) => m.name),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Ollama names omit ":latest" inconsistently; compare on the base name when no tag is given. */
export function hasModel(models: string[], wanted: string): boolean {
  const norm = (n: string) => (n.includes(":") ? n : `${n}:latest`);
  return models.some((m) => norm(m) === norm(wanted));
}

export interface DerivedModel {
  from: string;
  num_ctx: number;
}

/**
 * Creates `name` from a pulled base model with a fixed context size (POST /api/create). The base
 * must already be pulled; this never downloads weights.
 */
export async function createDerivedModel(
  baseUrl: string,
  name: string,
  spec: DerivedModel,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(new URL("/api/create", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: name,
      from: spec.from,
      parameters: { num_ctx: spec.num_ctx },
      stream: false,
    }),
  });
  const body = await res.text();
  if (!res.ok)
    throw new Error(`ollama create ${name} failed (${res.status}): ${body.slice(0, 300)}`);
}

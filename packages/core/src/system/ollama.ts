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

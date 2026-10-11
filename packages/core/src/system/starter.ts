import type { Hardware } from "@rocky/contracts";
import { z } from "zod";
import { updateUserYaml } from "../config/load.ts";
import type { PolicyFile } from "../router/policy.ts";
import { listLocalModels } from "./models.ts";
import { createDerivedModel, hasModel } from "./ollama.ts";

/**
 * First-run model download (roadmap A1, D-051): pick the starter model this machine's RAM can
 * hold (from `starter_models` in policies.yaml, tags checked on ollama.com), pull it and the
 * embedding model through Ollama, make the 16k-context copy, and use it for local answers.
 */

export type StarterModel = PolicyFile["starter_models"][number];

export function chooseStarter(
  policy: PolicyFile,
  hw: Pick<Hardware, "ramGb">,
): StarterModel | null {
  return policy.starter_models.find((s) => hw.ramGb >= s.min_ram_gb) ?? null;
}

const PullLine = z.object({
  status: z.string().default(""),
  total: z.number().optional(),
  completed: z.number().optional(),
  error: z.string().optional(),
});

export interface PullProgress {
  model: string;
  status: string;
  /** Bytes, when Ollama reports them for the current layer. */
  completed?: number;
  total?: number;
}

/** POST /api/pull, reading its newline-delimited JSON progress. Resumes a cancelled pull. */
export async function pullModel(
  baseUrl: string,
  model: string,
  onProgress: (p: PullProgress) => void,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(new URL("/api/pull", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body)
    throw new Error(
      `ollama pull ${model} failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
    );
  const decoder = new TextDecoder();
  let buf = "";
  let ok = false;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const p = PullLine.parse(JSON.parse(line));
    if (p.error) throw new Error(`ollama pull ${model}: ${p.error}`);
    if (p.status === "success") ok = true;
    onProgress({
      model,
      status: p.status,
      ...(p.total !== undefined ? { total: p.total } : {}),
      ...(p.completed !== undefined ? { completed: p.completed } : {}),
    });
  };
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  handle(buf);
  if (!ok) throw new Error(`ollama pull ${model} ended before it finished.`);
}

export async function setupStarterModel(o: {
  dataDir: string;
  baseUrl: string;
  policy: PolicyFile;
  hardware: Pick<Hardware, "ramGb">;
  onProgress: (p: PullProgress) => void;
  fetchFn?: typeof fetch;
}): Promise<{ model: string }> {
  const starter = chooseStarter(o.policy, o.hardware);
  if (!starter) throw new Error("No starter model is configured for this machine.");
  const fetchFn = o.fetchFn ?? fetch;
  let installed: string[];
  try {
    installed = (await listLocalModels(o.baseUrl, fetchFn)).map((m) => m.name);
  } catch (err) {
    throw new Error(`Ollama isn't running: ${err instanceof Error ? err.message : String(err)}`);
  }
  const embed = o.policy.models.embed?.replace(/^ollama\//, "");
  for (const m of [starter.pull, embed])
    if (m && !hasModel(installed, m)) await pullModel(o.baseUrl, m, o.onProgress, fetchFn);
  if (!hasModel(installed, starter.use)) {
    o.onProgress({ model: starter.use, status: "making the 16k-context copy" });
    await createDerivedModel(
      o.baseUrl,
      starter.use,
      { from: starter.pull, num_ctx: starter.num_ctx },
      fetchFn,
    );
  }
  updateUserYaml("policies", o.dataDir, {
    models: { "local:small": `ollama/${starter.use}`, "local:medium": `ollama/${starter.use}` },
  });
  return { model: starter.use };
}

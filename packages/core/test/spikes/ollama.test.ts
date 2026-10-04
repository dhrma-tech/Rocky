// Spike 3: Ollama embeddings via /api/embed, and chat structured output via the OpenAI-compatible
// endpoint (@ai-sdk/openai-compatible). Decides `local:small` in config/policies.yaml.
// Model under test: ROCKY_SPIKE_LOCAL_MODEL (default qwen3.5:4b). Skipped when Ollama or the
// models are missing.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, Output } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hasModel, ollamaStatus } from "../../src/index.ts";

const BASE = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const CHAT_MODEL = process.env.ROCKY_SPIKE_LOCAL_MODEL ?? "qwen3.5:4b";
const EMBED_MODEL = "nomic-embed-text";

const status = await ollamaStatus(BASE);
const models = status.ok ? status.models : [];

const Commitments = z.object({
  commitments: z.array(
    z.object({
      owner: z.string(),
      task: z.string(),
      due: z.string().nullable(),
      quote: z.string().describe("verbatim sentence from the transcript"),
    }),
  ),
});

const TRANSCRIPTS = [
  "Priya: I'll send the revised pricing deck to the board by Friday. Sam: Great, and I will book the venue for the offsite.",
  "Prof. Lee: Problem set 3 is due next Tuesday. Alex: I will email you my extension request tonight.",
  "Dana: Can someone fix the login bug? Omar: I'll take it and open a PR tomorrow.",
  "Mia: We decided to drop the free tier. Mia: I will update the website copy before the launch on the 14th.",
  "Ken: I owe Rita the Q3 numbers. Ken: I'll have them to her by end of day Monday.",
];

describe.skipIf(!status.ok || !hasModel(models, EMBED_MODEL))("spike: ollama embed", () => {
  it("returns 768-dim embeddings for a batch", async () => {
    const res = await fetch(new URL("/api/embed", BASE), {
      method: "POST",
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: ["search_document: hello", "search_query: hi"],
      }),
    });
    const body = (await res.json()) as { embeddings: number[][] };
    expect(body.embeddings).toHaveLength(2);
    expect(body.embeddings[0]).toHaveLength(768);
  });
});

describe.skipIf(!status.ok || !hasModel(models, CHAT_MODEL))(
  "spike: ollama structured output",
  () => {
    it(`extracts commitments as schema-valid JSON with ${CHAT_MODEL}`, async () => {
      const ollama = createOpenAICompatible({
        name: "ollama",
        baseURL: new URL("/v1", BASE).toString(),
        supportsStructuredOutputs: true,
        // Thinking models (qwen3.5) spend ~40 s reasoning per call on CPU; extraction doesn't need it.
        transformRequestBody: (body) => ({ ...body, reasoning_effort: "none" }),
      });
      let valid = 0;
      let verbatim = 0;
      let total = 0;
      const t0 = performance.now();
      for (const transcript of TRANSCRIPTS) {
        try {
          const res = await generateText({
            model: ollama(CHAT_MODEL),
            output: Output.object({ schema: Commitments }),
            system:
              "Extract every commitment (someone promising to do something). " +
              "`quote` must be copied verbatim from the transcript. Reply with JSON only.",
            prompt: transcript,
            temperature: 0,
            maxRetries: 0,
          });
          valid++;
          for (const c of res.output.commitments) {
            total++;
            if (transcript.includes(c.quote)) verbatim++;
          }
        } catch (err) {
          console.warn("invalid output:", err instanceof Error ? err.message.slice(0, 200) : err);
        }
      }
      const secs = (performance.now() - t0) / 1000;
      console.info(
        `${CHAT_MODEL}: valid JSON ${valid}/${TRANSCRIPTS.length}, verbatim quotes ${verbatim}/${total}, ` +
          `${(secs / TRANSCRIPTS.length).toFixed(1)} s per call`,
      );
      // Phase 0 bar: structured output works at all. Phase 3 requires 20/20 after retry.
      expect(valid).toBeGreaterThanOrEqual(4);
    });
  },
);

// A stand-in for Ollama in the fresh-clone CI job (PLAN §4.12: "a mocked model provider and a
// real SQLite store"). It is never used by the product. It serves just enough of Ollama's API:
//   GET  /api/version, /api/tags          (doctor)
//   POST /api/embed                       (deterministic bag-of-words vectors, 768 dims)
//   POST /v1/chat/completions             (OpenAI-compatible; JSON answers for ask and verify)
// The answer quotes the first sentence of the first <untrusted_data> chunk verbatim, so the real
// quote check and verifier pipeline run end to end.
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

const DIM = 768;

function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const i = createHash("md5").update(word).digest().readUInt16LE(0) % DIM;
    v[i] = (v[i] ?? 0) + 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

interface ChatBody {
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
}

const text = (c: ChatBody["messages"][number]["content"]) =>
  typeof c === "string" ? c : c.map((p) => p.text ?? "").join("");

/** First sentence (≤ 40 words) of the first wrapped chunk, with the chunk's id. */
function firstQuote(prompt: string): { id: string; quote: string } | null {
  const m = /<untrusted_data id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/untrusted_data>/.exec(prompt);
  if (!m?.[1] || !m[2]) return null;
  const body = m[2].replace(/\s+/g, " ").trim();
  const sentence = /^[^.!?]{12,}?[.!?](?=\s|$)/.exec(body)?.[0] ?? body;
  const quote = sentence.split(" ").slice(0, 30).join(" ");
  return { id: m[1], quote };
}

export function reply(body: ChatBody): unknown {
  const system = text(body.messages.find((m) => m.role === "system")?.content ?? "");
  const user = body.messages
    .filter((m) => m.role === "user")
    .map((m) => text(m.content))
    .join("\n");
  if (system.startsWith("You check whether each claim")) {
    const items = [...user.matchAll(/^Item (\d+)$/gm)].map((m) => Number(m[1]));
    return {
      labels: items.map((i) => ({ i, label: "SUPPORTED", reason: "fake verifier" })),
    };
  }
  const q = firstQuote(user);
  if (!q) return { sentences: [], notFound: true };
  return { sentences: [{ text: q.quote, citations: [q.id], quote: q.quote }], notFound: false };
}

export async function startFakeOllama(port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString();
    });
    req.on("end", () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/api/version")
        return send(200, { version: "0.0.0-fake" });
      if (req.method === "GET" && url === "/api/tags")
        return send(200, {
          models: [{ name: "nomic-embed-text:latest" }, { name: "rocky-qwen3.5-4b-16k:latest" }],
        });
      if (req.method === "POST" && url === "/api/embed") {
        const { input } = JSON.parse(raw) as { input: string | string[] };
        const list = Array.isArray(input) ? input : [input];
        return send(200, { model: "fake", embeddings: list.map(embed) });
      }
      if (req.method === "POST" && url === "/v1/chat/completions") {
        const content = JSON.stringify(reply(JSON.parse(raw) as ChatBody));
        return send(200, {
          id: "fake",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "fake",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
          usage: {
            prompt_tokens: Math.ceil(raw.length / 4),
            completion_tokens: 40,
            total_tokens: 0,
          },
        });
      }
      send(404, { error: `fake ollama: ${req.method} ${url} not served` });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: p } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${p}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { memorySecrets, openRuntime, upsertDocument } from "@rocky/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../../../packages/core/test/helpers.ts";

const cli = path.resolve(import.meta.dirname, "../src/index.ts");
let dir: string;

beforeAll(async () => {
  dir = tempDir();
  // A closed Ollama port: the query embedding fails and search falls back to keyword only.
  fs.writeFileSync(
    path.join(dir, "rocky.yaml"),
    ["ollama:", "  baseUrl: http://127.0.0.1:9", ""].join("\n"),
  );
  const rt = await openRuntime({ dataDir: dir, secrets: memorySecrets() });
  const text = "The capstone demo is on 14 November in room B12.";
  upsertDocument(rt.db, {
    parsed: {
      title: "Capstone schedule",
      sourceType: "text",
      text,
      units: [
        {
          anchor: { kind: "text" },
          start: 0,
          end: text.length,
          blocks: [{ type: "para", start: 0, end: text.length }],
        },
      ],
    },
    externalId: "capstone",
  });
  rt.close();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("rocky mcp (stdio, acceptance #1 without the claude binary)", () => {
  it("serves search_memory to a real MCP client over a child process", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--data-dir", dir, "mcp"],
      stderr: "pipe",
    });
    const client = new Client({ name: "acceptance", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("search_memory");
      const r = (await client.callTool({
        name: "search_memory",
        arguments: { query: "when is the capstone demo" },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(r.isError).toBeFalsy();
      const out = r.content.map((c) => c.text).join("\n");
      expect(out).toContain("Capstone schedule");
      expect(out).toContain("14 November");
    } finally {
      await client.close();
    }
  }, 60_000);
});

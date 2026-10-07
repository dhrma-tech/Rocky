import fs from "node:fs";
import http from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { memorySecrets, upsertDocument } from "@rocky/core";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../packages/core/test/helpers.ts";
import { HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
import { startDaemon } from "../src/index.ts";

describe("MCP over Streamable HTTP (daemon /api/v1/mcp)", () => {
  it("needs the install token, checks Host, and serves search_memory", async () => {
    const dir = tempDir();
    fs.writeFileSync(`${dir}/rocky.yaml`, "ollama:\n  baseUrl: http://127.0.0.1:9\n");
    const secrets = memorySecrets();
    const d = await startDaemon({
      dataDir: dir,
      port: 48_000 + Math.floor(Math.random() * 1000),
      log: () => {},
      setup: (rt) => {
        const text = "Rocky's HTTP endpoint test: the hackathon starts at 9am Saturday.";
        upsertDocument(rt.db, {
          parsed: {
            title: "Hackathon",
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
          externalId: "hackathon",
        });
      },
      runtime: {
        secrets,
        hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
      },
    });
    const url = `${d.url}/api/v1/mcp`;
    try {
      const init = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
      const noToken = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(init),
      });
      expect(noToken.status).toBe(401);
      const token = secrets.get("daemon-token") as string;
      // fetch drops a custom Host header; node:http sends it as given.
      const badHost = await new Promise<number>((resolve, reject) => {
        const req = http.request(url, {
          method: "POST",
          headers: {
            host: "evil.example",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end(JSON.stringify(init));
      });
      expect(badHost).toBe(403);

      const client = new Client({ name: "http-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      try {
        const r = (await client.callTool({
          name: "search_memory",
          arguments: { query: "when does the hackathon start" },
        })) as { content: { text: string }[] };
        expect(r.content.map((c) => c.text).join("\n")).toContain("9am Saturday");
      } finally {
        await client.close();
      }
    } finally {
      await d.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

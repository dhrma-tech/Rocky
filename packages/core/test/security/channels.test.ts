// D-065: phone channel secrets are readable only in the channel host; it reaches only the ntfy
// server and api.telegram.org; local-only blocks every send.
import { AppConfigSchema } from "@rocky/contracts";
import { describe, expect, it } from "vitest";
import {
  ChannelBlocked,
  channelEgress,
  channelOnlySecrets,
  connectorOnlySecrets,
  coreOnlySecrets,
  guardFetch,
  InProcessChannelHost,
  memorySecrets,
} from "../../src/index.ts";

describe("channel secrets", () => {
  it("only the channel host's view can read them; the daemon and connector host can't", () => {
    const raw = memorySecrets({
      anthropic: "k",
      "github.token": "g",
      "channel.ntfy-topic": "secret-topic",
    });
    const channel = channelOnlySecrets(raw);
    expect(channel.get("channel.ntfy-topic")).toBe("secret-topic");
    expect(() => channel.get("anthropic")).toThrow();
    expect(() => channel.get("github.token")).toThrow();
    expect(channel.list()).toEqual(["channel.ntfy-topic"]);

    // A connector (possibly a third-party plugin) can't read the phone channel's secrets.
    const connector = connectorOnlySecrets(raw);
    expect(() => connector.get("channel.ntfy-topic")).toThrow();
    expect(() => connector.set("channel.ntfy-topic", "x")).toThrow();
    expect(connector.list()).toEqual(["github.token"]);

    // The daemon (which calls models) can list and delete them for "delete everything", not read.
    const core = coreOnlySecrets(raw);
    expect(() => core.get("channel.ntfy-topic")).toThrow();
    expect(core.list()).toContain("channel.ntfy-topic");
    expect(core.delete("channel.ntfy-topic")).toBe(true);
  });
});

describe("channel host egress", () => {
  const config = AppConfigSchema.parse({
    notifications: { ntfy: { enabled: true, server: "https://ntfy.example.org" } },
  });

  it("reaches only the configured ntfy server and api.telegram.org", async () => {
    const seen: string[] = [];
    const base = (async (input: string) => {
      seen.push(input);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const guarded = guardFetch(base, () => channelEgress(config), "The channel host");
    await guarded("https://ntfy.example.org/topic");
    await guarded("https://api.telegram.org/botX/getMe");
    await expect(guarded("https://evil.example/exfil")).rejects.toThrow(/may not connect/);
    await expect(guarded("http://127.0.0.1:7337/api/v1/settings")).rejects.toThrow(
      /may not connect/,
    );
    expect(seen).toEqual(["https://ntfy.example.org/topic", "https://api.telegram.org/botX/getMe"]);
  });

  it("refuses to send in local-only mode even when the daemon asks", async () => {
    let called = false;
    const host = new InProcessChannelHost({
      secrets: memorySecrets({ "channel.ntfy-topic": "t" }),
      fetch: (async () => {
        called = true;
        return new Response("");
      }) as unknown as typeof fetch,
      config: () => ({ ...config, localOnly: true }),
    });
    await expect(
      host.sendNtfy({ title: "Rocky", text: "x", priority: "default" }),
    ).rejects.toBeInstanceOf(ChannelBlocked);
    expect(called).toBe(false);
  });

  it("a server setting must be https (http only on this computer)", () => {
    const bad = (server: string) =>
      AppConfigSchema.safeParse({ notifications: { ntfy: { server } } }).success;
    expect(bad("http://ntfy.example.org")).toBe(false);
    expect(bad("https://ntfy.example.org")).toBe(true);
    expect(bad("http://127.0.0.1:8080")).toBe(true);
    expect(bad("http://localhost.evil.example")).toBe(false);
  });
});

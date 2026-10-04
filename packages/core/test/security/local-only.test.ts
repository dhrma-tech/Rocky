// SECURITY.md: "Local-only is enforced". With local-only on, no task may open a non-loopback
// socket. A socket stub records and fails every outbound connect; loopback (Ollama) is served by
// a fake so the test needs no Ollama, while any other URL goes to the real fetch and hits the stub.
import net from "node:net";
import { TaskSchema } from "@rocky/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { EgressBlocked, TaskNeedsApi } from "../../src/router/errors.ts";
import { resolveChain } from "../../src/router/policy.ts";
import { memoryDb } from "../helpers.ts";
import { fakeProviders, HW_GPU, HW_HIGH, HW_LOW, harness, realPolicy } from "../router-helpers.ts";

const outbound: string[] = [];
const originalConnect = net.Socket.prototype.connect;
const LOOPBACK = /^(127\.|::1$|localhost$)/;

beforeAll(() => {
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const opts = args[0];
    const host =
      typeof opts === "object" && opts !== null
        ? String((opts as { host?: string }).host ?? "localhost")
        : String(args[1] ?? "localhost");
    if (!LOOPBACK.test(host)) {
      outbound.push(host);
      throw new Error(`socket stub: blocked outbound connect to ${host}`);
    }
    return originalConnect.apply(this, args as Parameters<typeof originalConnect>);
  } as typeof originalConnect;
});
afterAll(() => {
  net.Socket.prototype.connect = originalConnect;
});

const Out = z.object({ ok: z.boolean() });

describe("local-only egress", () => {
  it("the stub really blocks outbound sockets", async () => {
    await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow();
    expect(outbound.length).toBeGreaterThan(0);
    outbound.length = 0;
  });

  it.each(TaskSchema.options)(
    "task %s makes no outbound connection under local-only",
    async (task) => {
      for (const hw of [HW_LOW, HW_HIGH, HW_GPU]) {
        const db = memoryDb();
        const local = fakeProviders(() => ({ ok: true }));
        // Loopback goes to the fake; everything else uses the real fetch and therefore the socket stub.
        const fetch = ((input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input instanceof Request ? input.url : input));
          return LOOPBACK.test(url.hostname)
            ? local.fetch(input, init)
            : globalThis.fetch(input, init);
        }) as typeof globalThis.fetch;
        const h = harness(db, fetch, { hw });
        h.settings.localOnly = true;
        try {
          const r = await h.router.run({
            task,
            origin: "user_turn",
            system: "s",
            prompt: "p",
            schema: Out,
          });
          expect(r.path.local).toBe(true);
        } catch (e) {
          expect(e).toBeInstanceOf(TaskNeedsApi);
        }
        db.close();
      }
      expect(outbound).toEqual([]);
    },
  );

  it("scope/notebook local-only blocks API targets at the gate", async () => {
    const db = memoryDb();
    const h = harness(db, globalThis.fetch);
    const [api] = resolveChain(realPolicy(), "chat", { hardware: HW_HIGH, localOnly: false });
    await expect(
      h.gate.call(api as NonNullable<typeof api>, {
        task: "chat",
        origin: "user_turn",
        system: "s",
        prompt: "p",
        maxTokens: 5,
        timeoutMs: 1000,
        localOnly: true,
      }),
    ).rejects.toThrow(EgressBlocked);
    expect(outbound).toEqual([]);
    db.close();
  });
});

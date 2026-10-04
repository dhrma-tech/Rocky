import { z } from "zod";
import type { ActionDefinition } from "./types.ts";

const EchoPayload = z.object({ message: z.string().min(1).max(500), fail: z.boolean().optional() });
export type EchoPayload = z.infer<typeof EchoPayload>;

/**
 * Test-only action: records each call and writes nothing outside the process. Never registered
 * by the daemon; tests and dev smoke scripts register it explicitly.
 */
export function echoAction(calls: { payload: EchoPayload; idempotencyKey: string }[] = []) {
  const def: ActionDefinition<EchoPayload> = {
    type: "test.echo",
    title: "Echo (test)",
    schema: EchoPayload,
    risk: (p) => (p.message.includes("high") ? "high" : "low"),
    describe: (p) => ({ target: "test", summary: p.message }),
    async execute(p, ctx) {
      calls.push({ payload: p, idempotencyKey: ctx.idempotencyKey });
      if (p.fail) throw new Error("echo failed on purpose");
      return { echoed: p.message };
    },
  };
  return { def, calls };
}

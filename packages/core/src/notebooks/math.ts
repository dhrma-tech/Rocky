import { Worker } from "node:worker_threads";
import type { Computation, ComputedValue } from "@rocky/contracts";

/**
 * Math routing (notebooks.md): the model asks for computations by expression and writes
 * {{calc:id}} where the result goes. The daemon evaluates each expression with mathjs in a worker
 * (1 s timeout, 500-char cap) and substitutes the result, so the model never states a number.
 */

export const MAX_EXPR = 500;
const TIMEOUT_MS = 1000;
const WORKER = new URL("./math-worker.cjs", import.meta.url);

/** mathjs has no integrals or equation solving: say so instead of letting the model guess. */
const UNSUPPORTED = /\b(integrate|integral|solve|nsolve|limit|dsolve)\s*\(/i;

type Reply = { n: number; value: string } | { n: number; error: string };

/**
 * One long-lived worker: loading mathjs takes about a second, so it happens once. The 1 s limit
 * applies to each expression; on a timeout the worker is killed and the next call starts a new one.
 */
class Sandbox {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private n = 0;

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const w = new Worker(WORKER);
    w.unref();
    this.worker = w;
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (m: { ready?: boolean }) => {
        if (m.ready) {
          w.off("message", onReady);
          resolve();
        }
      };
      w.on("message", onReady);
      w.once("error", reject);
      w.once("exit", () => {
        if (this.worker === w) {
          this.worker = null;
          this.ready = null;
        }
      });
    });
    return this.ready;
  }

  async run(expr: string): Promise<{ value: string } | { error: string }> {
    try {
      await this.start();
    } catch (err) {
      this.kill();
      return { error: `math sandbox failed to start: ${String(err)}` };
    }
    const w = this.worker as Worker;
    const n = ++this.n;
    return new Promise((resolve) => {
      const onMessage = (m: Reply) => {
        if (m.n !== n) return;
        clearTimeout(timer);
        w.off("message", onMessage);
        resolve("value" in m ? { value: m.value } : { error: m.error });
      };
      const timer = setTimeout(() => {
        w.off("message", onMessage);
        this.kill();
        resolve({ error: "timed out after 1 s" });
      }, TIMEOUT_MS);
      w.on("message", onMessage);
      w.postMessage({ n, expr });
    });
  }

  kill(): void {
    void this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}

const sandbox = new Sandbox();

/** Stops the math worker (daemon shutdown, tests). */
export function stopMathSandbox(): void {
  sandbox.kill();
}

export async function evaluateComputations(list: Computation[]): Promise<ComputedValue[]> {
  const out: ComputedValue[] = [];
  for (const c of list.slice(0, 20)) {
    const base = { id: c.id, expr: c.expr, purpose: c.purpose };
    if (c.expr.length > MAX_EXPR)
      out.push({ ...base, value: null, notComputed: "expression is too long" });
    else if (UNSUPPORTED.test(c.expr))
      out.push({ ...base, value: null, notComputed: "this step needs a computer algebra system" });
    else {
      const r = await sandbox.run(c.expr);
      out.push(
        "value" in r
          ? { ...base, value: r.value, notComputed: null }
          : { ...base, value: null, notComputed: r.error },
      );
    }
  }
  return out;
}

/** Replaces {{calc:id}} with the computed value, or a visible "not computed" marker. */
export function substitute(text: string, results: ComputedValue[]): string {
  const byId = new Map(results.map((r) => [r.id, r]));
  return text.replace(/\{\{\s*calc:([a-z0-9_]+)\s*\}\}/gi, (_m, id: string) => {
    const r = byId.get(id);
    if (!r) return "[not computed]";
    return r.value ?? "[not computed: needs a computer algebra system or failed]";
  });
}

/**
 * Computed results the model wrote out itself instead of using the placeholder. Those numbers
 * are guesses as far as we're concerned, so callers flag or reject them.
 */
export function statedResults(text: string, results: ComputedValue[]): string[] {
  const withoutPlaceholders = text.replace(/\{\{\s*calc:[a-z0-9_]+\s*\}\}/gi, "");
  return results
    .filter((r) => r.value !== null && /\d/.test(r.value))
    .filter((r) => {
      const num = (r.value as string).split(" ")[0] as string;
      const variants = new Set([num, Number(num).toLocaleString("en-US")]);
      return [...variants].some((v) => v.length > 1 && withoutPlaceholders.includes(v));
    })
    .map((r) => r.id);
}

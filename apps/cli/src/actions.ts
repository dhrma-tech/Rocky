import { createInterface } from "node:readline/promises";
import { type ActionRecord, type ActionStatus, ActionStatusSchema } from "@rocky/contracts";
import { openRuntime, type Runtime, resolveDataDir } from "@rocky/core";

/**
 * `rocky actions …`: the approval queue without the UI. Approval binds to the hash of the payload
 * shown here (non-negotiable #1); `run` executes through the ActionService only. Runs in-process
 * like `rocky connectors`: the service's state changes are conditional, so it is safe alongside
 * a running daemon.
 */

export interface ActionsIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Asks a yes/no question; absent means no terminal (headless), which needs --yes. */
  confirm?: ((q: string) => Promise<boolean>) | undefined;
}

const short = (s: string) => s.slice(0, 12);

export function formatActionLine(a: ActionRecord): string {
  return `${a.id}  ${a.status.padEnd(9)} ${a.risk.padEnd(6)} ${a.title}`;
}

export function formatAction(a: ActionRecord): string {
  const lines = [
    `${a.title}  (${a.type}, ${a.risk} risk, ${a.status})`,
    `Target:  ${a.description.target}`,
    `Summary: ${a.description.summary}`,
  ];
  if (a.suspicious)
    lines.push("WARNING: a cited source looks like it contains injected instructions.");
  lines.push("", "Payload:", JSON.stringify(a.payload, null, 2), "");
  if (a.citations.length) {
    lines.push("Sources:");
    for (const c of a.citations) lines.push(`  - ${c.title}: "${c.quote}"`);
    lines.push("");
  }
  lines.push(`Payload hash: ${a.payloadHash}`);
  if (a.error) lines.push(`Error: ${a.error}`);
  if (a.result !== null && a.result !== undefined)
    lines.push(`Result: ${JSON.stringify(a.result)}`);
  return lines.join("\n");
}

/** Accepts a full id or a unique prefix of at least 6 characters. */
function resolveId(rt: Runtime, id: string): ActionRecord {
  if (id.length >= 26) return rt.actions.get(id);
  if (id.length < 6) throw new Error("Give the action id (or at least its first 6 characters).");
  const matches = rt.actions.list().filter((a) => a.id.startsWith(id.toUpperCase()));
  if (matches.length === 1 && matches[0]) return matches[0];
  throw new Error(
    matches.length ? `"${id}" matches ${matches.length} actions.` : `No action ${id}.`,
  );
}

export async function runActions(
  rt: Runtime,
  action: string,
  id: string | undefined,
  opts: { status?: string | undefined; yes?: boolean; json?: boolean },
  io: ActionsIo,
): Promise<number> {
  const print = (a: ActionRecord | ActionRecord[], text: string) =>
    io.out(opts.json ? JSON.stringify(a, null, 2) : text);

  if (action === "list") {
    let status: ActionStatus | undefined;
    if (opts.status) {
      const s = ActionStatusSchema.safeParse(opts.status);
      if (!s.success) {
        io.err(`--status must be one of: ${ActionStatusSchema.options.join(", ")}`);
        return 1;
      }
      status = s.data;
    }
    const list = rt.actions.list(status);
    print(list, list.length ? list.map(formatActionLine).join("\n") : "No actions.");
    return 0;
  }
  if (!id) {
    io.err(`rocky actions ${action} needs an action id.`);
    return 1;
  }
  const a = resolveId(rt, id);
  switch (action) {
    case "show":
      print(a, formatAction(a));
      return 0;
    case "approve": {
      if (a.status !== "draft") {
        io.err(`Only drafts can be approved; this one is ${a.status}.`);
        return 1;
      }
      // Show exactly what is approved; the hash shown is the hash bound.
      io.out(formatAction(a));
      if (!opts.yes) {
        if (!io.confirm) {
          io.err("No terminal to confirm on. Re-run with --yes to approve the payload shown.");
          return 1;
        }
        if (!(await io.confirm(`Approve this payload (hash ${short(a.payloadHash)}…)?`))) {
          io.err("Not approved.");
          return 1;
        }
      }
      const r = rt.actions.approve(a.id, a.payloadHash);
      io.out(`Approved ${r.id}. Run it with: rocky actions run ${r.id}`);
      return 0;
    }
    case "reject":
      rt.actions.reject(a.id);
      io.out(`Rejected ${a.id}.`);
      return 0;
    case "revoke":
      rt.actions.revoke(a.id);
      io.out(`Approval revoked; ${a.id} is a draft again.`);
      return 0;
    case "run": {
      const r = await rt.actions.execute(a.id);
      print(
        r,
        `${r.status === "executed" ? "Done" : r.status}: ${r.title}${r.error ? ` (${r.error})` : ""}`,
      );
      return r.status === "executed" ? 0 : 1;
    }
    default:
      io.err(`Unknown action "${action}". Use: list | show | approve | reject | revoke | run`);
      return 1;
  }
}

export async function actionsCommand(
  action: string,
  id: string | undefined,
  opts: { dataDir?: string | undefined; status?: string; yes?: boolean; json?: boolean },
): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const rt = await openRuntime({ dataDir: dir });
  try {
    // Executors come from the connectors; registering them is what lets `run` find them.
    if (action === "run") {
      const { registerConnectors } = await import("@rocky/daemon");
      await registerConnectors(rt, (m) => console.error(m));
    }
    const tty = process.stdin.isTTY && process.stdout.isTTY;
    return await runActions(rt, action, id, opts, {
      out: (s) => console.log(s),
      err: (s) => console.error(s),
      confirm: tty
        ? async (q) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
            } finally {
              rl.close();
            }
          }
        : undefined,
    });
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  } finally {
    rt.close();
  }
}

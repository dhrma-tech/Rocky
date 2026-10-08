import { type RuleCreate, RuleCreateSchema } from "@rocky/contracts";
import { openRuntime, resolveDataDir } from "@rocky/core";

/**
 * `rocky rules list | add --json <rule> | preview --json <rule> | revoke <id>` (roadmap A4).
 * An allow rule needs an action type, at least one condition and an end date; the plain-language
 * sentence and the number of past approvals it would have skipped are shown before saving.
 */
export async function rulesCommand(
  action: string,
  id: string | undefined,
  opts: { dataDir?: string | undefined; json?: string; yes?: boolean },
): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const rt = await openRuntime({ dataDir: dir });
  try {
    // Rules name action types, which come from the added connectors (definitions only; no tokens).
    const { registerConnectors } = await import("@rocky/daemon");
    await registerConnectors(rt, (m) => console.error(m));
    const rules = rt.actions.rules;
    switch (action) {
      case "list": {
        const all = rules.list();
        if (!all.length) console.log("No custom rules. Rocky asks before risky actions.");
        for (const r of all)
          console.log(
            `${r.id}  ${r.active ? "active " : "ended  "} ${r.effect.padEnd(5)}  ${r.sentence}`,
          );
        return 0;
      }
      case "preview":
      case "add": {
        let raw: unknown = null;
        try {
          raw = JSON.parse(opts.json ?? "");
        } catch {
          // reported below
        }
        const parsed = RuleCreateSchema.safeParse(raw);
        if (!parsed.success) {
          console.error(
            `Give the rule as --json '<rule>'. ${parsed.error.issues.map((i) => `${i.path.join(".") || "rule"}: ${i.message}`).join("; ")}`,
          );
          return 1;
        }
        const input: RuleCreate = parsed.data;
        const p = rules.preview(input);
        console.log(p.sentence);
        if (input.effect === "allow")
          console.log(
            `It would have skipped ${p.wouldHaveSkipped} of your approvals in the last 90 days.`,
          );
        for (const problem of p.problems) console.error(`Can't save: ${problem}`);
        if (action === "preview" || p.problems.length) return p.problems.length ? 1 : 0;
        if (!opts.yes) {
          console.error("Re-run with --yes to save this rule.");
          return 1;
        }
        console.log(`Saved ${rules.create(input).id}.`);
        return 0;
      }
      case "revoke": {
        if (!id) {
          console.error("Usage: rocky rules revoke <id>");
          return 1;
        }
        const r = rules.revoke(id);
        console.log(`Revoked: ${r.sentence}`);
        return 0;
      }
      default:
        console.error(`Unknown action "${action}". Use: list | preview | add | revoke`);
        return 1;
    }
  } finally {
    rt.close();
  }
}

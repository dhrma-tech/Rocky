import { exportMemory, listMemory, resolveDataDir } from "@rocky/core";

/** `rocky memory list | export <dir>` (roadmap A5): your memory is plain files; take them with you. */
export function memoryCommand(
  action: string,
  target: string | undefined,
  opts: { dataDir?: string | undefined },
): number {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  if (action === "list") {
    const files = listMemory(dir);
    if (!files.length)
      console.log("Rocky hasn't remembered anything yet. It asks before it saves anything.");
    for (const f of files) {
      console.log(`${f.path} (${f.group}, ${f.facts.length} facts)`);
      for (const fact of f.facts)
        console.log(
          `  - ${fact.text}  [${fact.provenance?.by === "source" ? `from "${fact.provenance.title}"` : fact.provenance?.by === "user" ? "you" : "no source"}]`,
        );
    }
    return 0;
  }
  if (action === "export") {
    if (!target) {
      console.error("Usage: rocky memory export <folder>");
      return 1;
    }
    const files = exportMemory(dir, target);
    console.log(`Copied ${files.length} Markdown file(s) to ${target}.`);
    return 0;
  }
  console.error(`Unknown action "${action}". Use: list | export`);
  return 1;
}

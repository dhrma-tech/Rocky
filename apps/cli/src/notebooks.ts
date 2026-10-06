import fs from "node:fs";
import {
  addSource,
  ankiCsv,
  createNotebook,
  latestStudyGuide,
  listNotebooks,
  openRuntime,
  resolveDataDir,
  studyGuideMarkdown,
} from "@rocky/core";

/** `rocky notebooks …`: list, create (with rules), add a source, export Anki or Markdown. */
export async function notebooksCommand(
  action: string,
  args: string[],
  opts: {
    dataDir?: string | undefined;
    titleMatch?: string;
    driveFolder?: string;
    notionPage?: string;
    format?: string;
    out?: string;
  },
): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const rt = await openRuntime({ dataDir: dir });
  try {
    const [first, second] = args;
    switch (action) {
      case "list": {
        const list = listNotebooks(rt.db);
        if (!list.length)
          console.log(
            'No notebooks yet. Create one: rocky notebooks create "Linear algebra" --title-match MA201',
          );
        for (const n of list)
          console.log(
            `${n.id}  ${n.name.padEnd(28)} ${String(n.sourceCount).padStart(4)} sources  ${n.cardCount} cards (${n.dueCount} due)` +
              (n.nextExam
                ? `  next exam ${new Date(n.nextExam.at).toISOString().slice(0, 10)}`
                : "") +
              (n.localOnly ? "  [local only]" : ""),
          );
        return 0;
      }
      case "create": {
        if (!first)
          throw new Error(
            'Usage: rocky notebooks create "<name>" [--title-match CODE] [--drive-folder ID] [--notion-page ID]',
          );
        const rules = {
          ...(opts.titleMatch
            ? { titleMatches: opts.titleMatch.split(",").map((s) => s.trim()) }
            : {}),
          ...(opts.driveFolder
            ? { driveFolderIds: opts.driveFolder.split(",").map((s) => s.trim()) }
            : {}),
          ...(opts.notionPage
            ? { notionPageIds: opts.notionPage.split(",").map((s) => s.trim()) }
            : {}),
        };
        const n = createNotebook(rt.db, { name: first, scope: { rules } });
        console.log(`Created ${n.name} (${n.id}) with ${n.sourceCount} source(s).`);
        return 0;
      }
      case "add-source": {
        if (!first || !second)
          throw new Error("Usage: rocky notebooks add-source <notebook id> <document id>");
        const n = addSource(rt.db, first, second);
        console.log(`${n.name} now has ${n.sourceCount} source(s).`);
        return 0;
      }
      case "export": {
        if (!first)
          throw new Error("Usage: rocky notebooks export <id> --format anki|md [--out file]");
        let text: string;
        if (opts.format === "md") {
          const guide = latestStudyGuide(rt.db, first);
          if (!guide)
            throw new Error("No study guide yet: build it in the web UI (Notebook → Exports).");
          text = studyGuideMarkdown(guide);
        } else text = ankiCsv(rt.db, first);
        if (opts.out) {
          fs.writeFileSync(opts.out, text);
          console.log(`Wrote ${opts.out}`);
        } else process.stdout.write(text);
        return 0;
      }
      default:
        throw new Error(`Unknown action "${action}". Try: list, create, add-source, export`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    rt.close();
  }
}

import fs from "node:fs";
import path from "node:path";
import { listPacks, repoTemplatesDir, resolveDataDir } from "@rocky/core";

/**
 * `rocky templates list | eject <pack>`: template packs are editable Markdown and YAML. Ejecting
 * copies a shipped pack into `<dataDir>/templates/<pack>`, where edits override the shipped files.
 */
export function templatesCommand(
  action: string,
  pack: string | undefined,
  opts: { dataDir?: string | undefined; force?: boolean },
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
  },
): number {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const overrides = path.join(dir, "templates");
  if (action === "list") {
    for (const p of listPacks(dir)) {
      const local = fs.existsSync(path.join(overrides, p.id)) ? " (customized)" : "";
      io.out(`${p.id}${local}: ${p.name}. ${p.description}`);
      for (const r of p.routines) io.out(`  - ${r.name} (${r.schedule})`);
    }
    io.out(`\nOverrides: ${overrides}`);
    return 0;
  }
  if (action === "eject") {
    if (!pack || !/^[a-z0-9-]+$/.test(pack)) {
      io.err("Usage: rocky templates eject <pack>   (see rocky templates list)");
      return 1;
    }
    const src = path.join(repoTemplatesDir, pack);
    if (!fs.existsSync(path.join(src, "pack.yaml"))) {
      io.err(`No shipped pack "${pack}".`);
      return 1;
    }
    const dest = path.join(overrides, pack);
    let copied = 0;
    let kept = 0;
    const walk = (from: string) => {
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, e.name);
        const d = path.join(dest, path.relative(src, s));
        if (e.isDirectory()) walk(s);
        else if (fs.existsSync(d) && !opts.force) {
          if (!fs.readFileSync(d).equals(fs.readFileSync(s))) kept++;
        } else {
          fs.mkdirSync(path.dirname(d), { recursive: true });
          fs.copyFileSync(s, d);
          copied++;
        }
      }
    };
    walk(src);
    io.out(
      `Copied ${copied} file(s) to ${dest}${kept ? `; kept ${kept} you already edited (--force overwrites)` : ""}.`,
    );
    io.out(
      "Edit them there; they override the shipped pack. Routines edited in the app win over both.",
    );
    return 0;
  }
  io.err(`Unknown action "${action}". Use: list | eject <pack>`);
  return 1;
}

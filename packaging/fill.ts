// Fills the package manager templates for one release (packaging/README.md):
//   node packaging/fill.ts v0.1.0 SHA256SUMS.txt   → packaging/out/
import fs from "node:fs";
import path from "node:path";

const [tag, sumsFile] = process.argv.slice(2);
if (!tag || !sumsFile) {
  console.error("usage: node packaging/fill.ts <tag> <SHA256SUMS.txt>");
  process.exit(1);
}
const version = tag.replace(/^v/, "");
const sums = new Map<string, string>();
for (const line of fs.readFileSync(sumsFile, "utf8").split("\n")) {
  const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
  if (m?.[1] && m[2]) sums.set(m[2], m[1]);
}

const here = import.meta.dirname;
const out = path.join(here, "out");
for (const dir of ["winget", "scoop", "homebrew"])
  for (const file of fs.readdirSync(path.join(here, dir))) {
    let text = fs
      .readFileSync(path.join(here, dir, file), "utf8")
      .replaceAll("{{VERSION}}", version);
    text = text.replace(/\{\{SHA256:([^}]+)\}\}/g, (_m, name: string) => {
      const sum = sums.get(name);
      if (!sum) throw new Error(`${name} is not in ${sumsFile}`);
      return sum;
    });
    fs.mkdirSync(path.join(out, dir), { recursive: true });
    fs.writeFileSync(path.join(out, dir, file), text);
  }
console.log(`filled for ${version} in ${out}`);

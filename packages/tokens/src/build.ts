// `pnpm tokens`: regenerates tokens.css from tokens.json.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renderCss } from "./index.ts";

const out = fileURLToPath(new URL("./tokens.css", import.meta.url));
fs.writeFileSync(out, renderCss());
console.log(`wrote ${out}`);

import fs from "node:fs";
import path from "node:path";

/** Free bytes on the volume holding `dir` (walks up to the nearest existing ancestor). */
export function freeBytes(dir: string): number {
  let p = path.resolve(dir);
  while (!fs.existsSync(p)) {
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  const s = fs.statfsSync(p);
  return s.bavail * s.bsize;
}

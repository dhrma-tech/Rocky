import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

/** Content-addressed blob path: blobs/ab/abcdef… */
export function blobPath(blobsDir: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
  return path.join(blobsDir, hash.slice(0, 2), hash);
}

/** Stores bytes once; returns the sha256. Writes go through a temp file so a crash leaves no partial blob. */
export function putBlob(blobsDir: string, bytes: Uint8Array): string {
  const hash = sha256(bytes);
  const dest = blobPath(blobsDir, hash);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, dest);
  }
  return hash;
}

export function removeBlob(blobsDir: string, hash: string): void {
  fs.rmSync(blobPath(blobsDir, hash), { force: true });
}

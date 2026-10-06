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

/** Hashes a file without loading it into memory. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Stores a file as a blob without reading it into memory (recordings, lecture videos).
 * `move` renames the source into place when possible instead of copying it.
 */
export async function putBlobFile(
  blobsDir: string,
  file: string,
  opts: { move?: boolean } = {},
): Promise<string> {
  const hash = await sha256File(file);
  const dest = blobPath(blobsDir, hash);
  if (fs.existsSync(dest)) {
    if (opts.move) fs.rmSync(file, { force: true });
    return hash;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  if (opts.move) {
    try {
      fs.renameSync(file, tmp);
    } catch {
      // Different volume: fall back to a copy.
      fs.copyFileSync(file, tmp);
      fs.rmSync(file, { force: true });
    }
  } else {
    fs.copyFileSync(file, tmp);
  }
  fs.renameSync(tmp, dest);
  return hash;
}

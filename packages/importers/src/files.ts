import fs from "node:fs";
import path from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import type { ArchiveFiles } from "./types.ts";

/** Only text files are read; photos, voice notes and videos in an export are skipped. */
const KEEP = /\.(txt|json|js|csv)$/i;
/** Text inside an export is rarely large. Guard against a zip bomb all the same. */
export const MAX_TEXT_BYTES = 512 * 1024 * 1024;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\//, "");
const stem = (p: string) => path.basename(p).replace(/\.[^.]+$/, "");
const tooLarge = () => new Error("The text inside this export is larger than 512 MB.");

/**
 * Streams a zip and inflates only its text entries, so a multi-GB WhatsApp export with media
 * never sits in memory. Entries are read from local headers as the bytes arrive.
 */
export async function filesFromZipStream(
  name: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<ArchiveFiles> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    if (!KEEP.test(file.name) || file.name.startsWith("__MACOSX/") || file.name.endsWith("/"))
      return;
    const parts: Uint8Array[] = [];
    file.ondata = (err, data, final) => {
      if (failure) return;
      if (err) {
        failure = new Error(`${file.name}: ${err.message}`);
        return;
      }
      total += data.length;
      if (total > MAX_TEXT_BYTES) {
        failure = tooLarge();
        return;
      }
      parts.push(data);
      if (final) files.set(norm(file.name), concat(parts));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  let last: Uint8Array | null = null;
  for await (const chunk of source) {
    if (last) unzip.push(last);
    if (failure) throw failure;
    last = chunk;
  }
  unzip.push(last ?? new Uint8Array(), true);
  if (failure) throw failure;
  return { name: stem(name), files };
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Reads an export: a zip, a single file (.txt, .js, .csv, .json) or an unpacked folder. */
export async function readArchive(target: string): Promise<ArchiveFiles> {
  const abs = path.resolve(target);
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (/\.zip$/i.test(abs)) return filesFromZipStream(abs, fs.createReadStream(abs));
    if (stat.size > MAX_TEXT_BYTES) throw tooLarge();
    return {
      name: stem(abs),
      files: new Map([[path.basename(abs), new Uint8Array(fs.readFileSync(abs))]]),
    };
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && KEEP.test(e.name)) {
        total += fs.statSync(full).size;
        if (total > MAX_TEXT_BYTES) throw tooLarge();
        files.set(norm(path.relative(abs, full)), new Uint8Array(fs.readFileSync(full)));
      }
    }
  };
  walk(abs);
  return { name: path.basename(abs), files };
}

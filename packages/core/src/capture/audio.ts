import fs from "node:fs";

/** All captured and imported audio is normalized to 16 kHz mono signed 16-bit PCM (whisper's input). */
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const WAV_HEADER_BYTES = 44;

export const pcmDurationMs = (pcmBytes: number) =>
  Math.round((pcmBytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000);

/** A canonical 44-byte RIFF/WAVE header for 16-bit PCM. */
export function wavHeader(dataBytes: number, sampleRate = SAMPLE_RATE, channels = 1): Buffer {
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  const blockAlign = channels * BYTES_PER_SAMPLE;
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Sums two Int16 PCM buffers sample by sample, clamping. The shorter one is treated as silence. */
export function mixPcm(a: Uint8Array, b: Uint8Array): Buffer {
  const n = Math.max(a.length, b.length) >> 1;
  const out = Buffer.alloc(n * 2);
  const va = new DataView(a.buffer, a.byteOffset, a.length & ~1);
  const vb = new DataView(b.buffer, b.byteOffset, b.length & ~1);
  for (let i = 0; i < n; i++) {
    const s =
      (i * 2 < va.byteLength ? va.getInt16(i * 2, true) : 0) +
      (i * 2 < vb.byteLength ? vb.getInt16(i * 2, true) : 0);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return out;
}

/**
 * Mixes two raw PCM files into one WAV in 1 MB blocks, so a two-hour recording never sits in
 * memory. Either input may be missing (mic-only recording).
 */
export function mixPcmFilesToWav(inputs: (string | undefined)[], outWav: string): number {
  const fds = inputs
    .filter((p): p is string => !!p && fs.existsSync(p))
    .map((p) => fs.openSync(p, "r"));
  const sizes = fds.map((fd) => fs.fstatSync(fd).size);
  const total = (Math.max(0, ...sizes) >> 1) << 1;
  const out = fs.openSync(outWav, "w");
  try {
    fs.writeSync(out, wavHeader(total));
    const BLOCK = 1 << 20;
    for (let pos = 0; pos < total; pos += BLOCK) {
      const len = Math.min(BLOCK, total - pos);
      const bufs = fds.map((fd) => {
        const b = Buffer.alloc(len);
        const read = fs.readSync(fd, b, 0, len, pos);
        return b.subarray(0, read);
      });
      const mixed = bufs.reduce<Buffer>((acc, b) => mixPcm(acc, b), Buffer.alloc(0));
      const block = Buffer.alloc(len);
      mixed.copy(block);
      fs.writeSync(out, block);
    }
  } finally {
    fs.closeSync(out);
    for (const fd of fds) fs.closeSync(fd);
  }
  return total;
}

/** Wraps a raw PCM file into a WAV next to it (header + data, streamed). Returns data bytes. */
export function pcmFileToWav(pcm: string, outWav: string): number {
  const size = (fs.statSync(pcm).size >> 1) << 1;
  const out = fs.openSync(outWav, "w");
  const src = fs.openSync(pcm, "r");
  try {
    fs.writeSync(out, wavHeader(size));
    const buf = Buffer.alloc(1 << 20);
    for (let pos = 0; pos < size; ) {
      const n = fs.readSync(src, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      fs.writeSync(out, buf, 0, n);
      pos += n;
    }
  } finally {
    fs.closeSync(src);
    fs.closeSync(out);
  }
  return size;
}

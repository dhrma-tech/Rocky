/** Whisper's input format: 16 kHz mono signed 16-bit PCM (capture.md step 4). */
export const TARGET_RATE = 16_000;

/**
 * Downsamples mono float audio by averaging each output sample's input window (a cheap
 * low-pass that avoids most aliasing for speech). Works for any input rate ≥ 16 kHz.
 */
export function downsample(
  input: Float32Array,
  inputRate: number,
  targetRate = TARGET_RATE,
): Float32Array {
  if (inputRate === targetRate) return input;
  if (inputRate < targetRate) throw new Error(`Input rate ${inputRate} is below ${targetRate}`);
  const ratio = inputRate / targetRate;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] as number;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Float [-1, 1] → little-endian Int16 bytes, clamped. */
export function toInt16(samples: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    out.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

export function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Buffers frames from one source and hands out exact 16 kHz Int16 chunks. Leftover input that
 * doesn't fill a whole output sample carries over to the next chunk, so time never drifts.
 */
export class ChannelBuffer {
  private frames: Float32Array[] = [];
  private readonly inputRate: number;

  constructor(inputRate: number) {
    this.inputRate = inputRate;
  }

  push(frame: Float32Array): void {
    this.frames.push(frame);
  }

  /** Input samples buffered so far. */
  get length(): number {
    return this.frames.reduce((n, f) => n + f.length, 0);
  }

  /** Takes everything buffered and returns it as 16 kHz Int16 bytes. */
  take(): Uint8Array {
    const all = concat(this.frames);
    const ratio = this.inputRate / TARGET_RATE;
    const usable = Math.floor(Math.floor(all.length / ratio) * ratio);
    this.frames = usable < all.length ? [all.slice(usable)] : [];
    return toInt16(downsample(all.subarray(0, usable), this.inputRate));
  }
}

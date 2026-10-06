import { describe, expect, it } from "vitest";
import { ChannelBuffer, downsample, toInt16 } from "../src/audio/pcm.ts";

describe("pcm helpers", () => {
  it("downsamples 48 kHz to 16 kHz by averaging windows", () => {
    const input = new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6, 1, 0, 0.5]);
    expect([...downsample(input, 48_000)].map((x) => Number(x.toFixed(3)))).toEqual([
      0.3, -0.6, 0.5,
    ]);
    expect(() => downsample(input, 8000)).toThrow();
  });

  it("converts to clamped little-endian Int16", () => {
    const b = toInt16(new Float32Array([0, 1, -1, 2, -0.5]));
    const v = new DataView(b.buffer);
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(i * 2, true))).toEqual([
      0, 32767, -32768, 32767, -16384,
    ]);
  });

  it("carries leftover input between chunks so 5 s of 44.1 kHz is exactly 5 s at 16 kHz", () => {
    const buf = new ChannelBuffer(44_100);
    let samples = 0;
    for (let i = 0; i < 5 * 44_100; i += 128)
      buf.push(new Float32Array(Math.min(128, 5 * 44_100 - i)));
    samples += buf.take().length / 2;
    for (let i = 0; i < 5 * 44_100; i += 128)
      buf.push(new Float32Array(Math.min(128, 5 * 44_100 - i)));
    samples += buf.take().length / 2;
    expect(Math.abs(samples - 10 * 16_000)).toBeLessThanOrEqual(1);
    expect(buf.length).toBeLessThan(3);
  });
});

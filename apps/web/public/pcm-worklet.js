// AudioWorklet: downmixes each render quantum to mono and posts it to the main thread, where it
// is resampled to 16 kHz Int16 (src/audio/pcm.ts). Kept tiny: worklets can't import app modules.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.paused = false;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.paused === "boolean") this.paused = e.data.paused;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (this.paused || !input || input.length === 0) return true;
    const n = input[0].length;
    const mono = new Float32Array(n);
    for (const ch of input) for (let i = 0; i < n; i++) mono[i] += ch[i] / input.length;
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);

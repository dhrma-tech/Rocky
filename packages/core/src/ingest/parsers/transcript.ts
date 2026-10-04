import path from "node:path";
import type { Parser, Unit } from "../types.ts";
import { TextBuilder } from "./text-blocks.ts";

const WINDOW_MS = 60_000;

interface Cue {
  startMs: number;
  endMs: number | undefined;
  speaker: string | undefined;
  text: string;
}

const TS = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?`;
const toMs = (m: RegExpExecArray, i: number) => {
  const [a, b, c, frac] = [m[i], m[i + 1], m[i + 2], m[i + 3]].map((x) =>
    x === undefined ? undefined : Number(x),
  );
  const [h, min, s] = c === undefined ? [0, a ?? 0, b ?? 0] : [a ?? 0, b ?? 0, c];
  const ms = frac === undefined ? 0 : Number(String(m[i + 3]).padEnd(3, "0"));
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
};

/** `[00:01:23] Name: text` or `00:01:23 Name: text` lines. */
function parseBracketed(src: string): Cue[] {
  const re = new RegExp(String.raw`^\[?${TS}\]?\s+(?:([^:]{1,40}):\s+)?(.+)$`);
  const cues: Cue[] = [];
  for (const line of src.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (m)
      cues.push({
        startMs: toMs(m, 1),
        endMs: undefined,
        speaker: m[5]?.trim(),
        text: m[6]?.trim() ?? "",
      });
    else if (line.trim() && cues.length) (cues.at(-1) as Cue).text += ` ${line.trim()}`;
  }
  return cues;
}

/** WebVTT cues; `<v Name>` voice tags become speakers. */
function parseVtt(src: string): Cue[] {
  const re = new RegExp(String.raw`^${TS}\s+-->\s+${TS}`);
  const cues: Cue[] = [];
  const blocks = src.replace(/\r\n?/g, "\n").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) continue;
    const m = re.exec(lines[i] ?? "") as RegExpExecArray;
    let body = lines
      .slice(i + 1)
      .join(" ")
      .trim();
    const voice = /^<v\s+([^>]+)>/.exec(body);
    if (voice) body = body.replace(/<[^>]+>/g, "").trim();
    cues.push({ startMs: toMs(m, 1), endMs: toMs(m, 5), speaker: voice?.[1]?.trim(), text: body });
  }
  return cues;
}

export const transcriptParser: Parser = {
  extensions: [".vtt", ".transcript.txt"],
  async parse({ bytes, filename }) {
    const src = new TextDecoder("utf-8").decode(bytes);
    const cues = filename.toLowerCase().endsWith(".vtt") ? parseVtt(src) : parseBracketed(src);
    const b = new TextBuilder();
    const units: Unit[] = [];
    let unit: Unit | undefined;
    cues.forEach((cue, i) => {
      const endMs = cue.endMs ?? cues[i + 1]?.startMs ?? cue.startMs;
      // A new unit starts when the current window would exceed 60 s.
      if (unit?.anchor.kind !== "transcript" || endMs - unit.anchor.startMs > WINDOW_MS) {
        unit = {
          anchor: { kind: "transcript", startMs: cue.startMs, endMs },
          start: -1,
          end: -1,
          blocks: [],
        };
        units.push(unit);
      }
      b.add("para", cue.speaker ? `${cue.speaker}: ${cue.text}` : cue.text);
      const block = b.blocks.at(-1);
      if (!block || unit.anchor.kind !== "transcript") return;
      unit.anchor.endMs = endMs;
      if (unit.start < 0) unit.start = block.start;
      unit.end = block.end;
      unit.blocks.push(block);
    });
    const name = path.basename(filename).replace(/\.(vtt|transcript\.txt)$/i, "");
    return {
      title: name,
      sourceType: "transcript",
      text: b.text,
      units: units.filter((u) => u.start >= 0),
    };
  },
};

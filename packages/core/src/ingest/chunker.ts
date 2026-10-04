import type { Anchor } from "@rocky/contracts";
import type { ParsedDoc } from "./types.ts";

export interface ChunkDraft {
  ord: number;
  text: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
  anchor: Anchor;
  sectionPath: string;
}

export interface ChunkOptions {
  targetTokens?: number;
  hardCapTokens?: number;
  /** Share of the target carried over between neighbouring chunks of the same unit. */
  overlap?: number;
}

/** ~4 chars per token for English. Chunk sizing only; the router budgets conservatively. */
export const chunkTokens = (s: string) => Math.ceil(s.length / 4);

interface Piece {
  start: number;
  end: number;
  heading?: { level: number; text: string };
}

/** Splits [start,end) into sentence ranges; overlong sentences are cut on whitespace. */
function splitLong(text: string, start: number, end: number, capChars: number): Piece[] {
  const out: Piece[] = [];
  const re = /[^.!?\n]+(?:[.!?]+|\n|$)\s*/g;
  re.lastIndex = start;
  const slice = text.slice(0, end);
  for (let m = re.exec(slice); m && m.index < end; m = re.exec(slice)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    let s = m.index;
    const e = Math.min(m.index + m[0].length, end);
    while (e - s > capChars) {
      const cut = text.lastIndexOf(" ", s + capChars);
      const at = cut > s ? cut + 1 : s + capChars;
      out.push({ start: s, end: at });
      s = at;
    }
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}

/** Trims whitespace off a range so chunk text and offsets agree exactly. */
function trimRange(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s] ?? "")) s++;
  while (e > s && /\s/.test(text[e - 1] ?? "")) e--;
  return [s, e];
}

/**
 * Structure-aware chunking (memory.md): split on headings, then paragraphs, then sentences;
 * pack to ~targetTokens with a hard cap; overlap only within one anchor unit; never cross units.
 */
export function chunkDocument(doc: ParsedDoc, opts: ChunkOptions = {}): ChunkDraft[] {
  const target = opts.targetTokens ?? 350;
  const hardCap = opts.hardCapTokens ?? 900;
  const overlapTokens = Math.floor(target * (opts.overlap ?? 0.15));
  const out: ChunkDraft[] = [];
  const headings: { level: number; text: string }[] = [];
  const sectionPath = () => headings.map((h) => h.text).join(" > ");

  for (const unit of doc.units) {
    const pieces: Piece[] = [];
    for (const b of unit.blocks) {
      if (b.type === "heading") {
        pieces.push({
          start: b.start,
          end: b.end,
          heading: { level: b.level ?? 1, text: doc.text.slice(b.start, b.end) },
        });
      } else if (chunkTokens(doc.text.slice(b.start, b.end)) > hardCap) {
        pieces.push(...splitLong(doc.text, b.start, b.end, hardCap * 4));
      } else {
        pieces.push({ start: b.start, end: b.end });
      }
    }

    let cur: Piece[] = [];
    let path = sectionPath();
    const emit = () => {
      const first = cur[0];
      const last = cur.at(-1);
      if (!first || !last) return;
      // A chunk that is only a heading carries no content; its text leads the next chunk instead.
      if (cur.every((p) => p.heading)) return;
      const [s, e] = trimRange(doc.text, first.start, last.end);
      const text = doc.text.slice(s, e);
      out.push({
        ord: out.length,
        text,
        charStart: s,
        charEnd: e,
        tokenCount: chunkTokens(text),
        anchor: unit.anchor,
        sectionPath: path,
      });
    };
    const tokensOf = (ps: Piece[]) => {
      const first = ps[0];
      const last = ps.at(-1);
      return first && last ? chunkTokens(doc.text.slice(first.start, last.end)) : 0;
    };

    for (const piece of pieces) {
      if (piece.heading) {
        if (cur.some((p) => !p.heading)) {
          emit();
          cur = [];
        }
        while ((headings.at(-1)?.level ?? 0) >= piece.heading.level) headings.pop();
        headings.push(piece.heading);
        path = sectionPath();
        cur.push(piece);
        continue;
      }
      if (cur.some((p) => !p.heading) && tokensOf([...cur, piece]) > target) {
        emit();
        // Carry trailing non-heading pieces up to the overlap budget into the next chunk.
        const carry: Piece[] = [];
        for (let i = cur.length - 1; i >= 0; i--) {
          const p = cur[i];
          if (!p || p.heading || tokensOf([p, ...carry]) > overlapTokens) break;
          carry.unshift(p);
        }
        cur = tokensOf([...carry, piece]) > hardCap ? [] : carry;
      }
      cur.push(piece);
    }
    emit();
  }
  return out;
}

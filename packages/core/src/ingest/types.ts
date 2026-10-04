import type { Anchor, SourceType } from "@rocky/contracts";

/** A structural block inside a unit, as a char range into ParsedDoc.text. */
export interface Block {
  type: "heading" | "para";
  level?: number;
  start: number;
  end: number;
}

/**
 * An anchor unit: a span chunks never cross (PDF page, transcript window ≤ 60 s, message, …).
 * `anchor` carries the location; char ranges live on the chunk.
 */
export interface Unit {
  anchor: Anchor;
  start: number;
  end: number;
  blocks: Block[];
}

export interface ParsedDoc {
  title: string;
  sourceType: SourceType;
  /** Becomes documents.raw_text; every offset below indexes into it. */
  text: string;
  units: Unit[];
  meta?: Record<string, unknown>;
}

export interface ParseInput {
  bytes: Uint8Array;
  filename: string;
}

export interface Parser {
  /** Lowercase extensions including the dot, e.g. ".pdf". */
  extensions: string[];
  parse(input: ParseInput): Promise<ParsedDoc>;
}

import path from "node:path";
import type { SourceDocument } from "@rocky/connector-sdk";
import { type SourceType, SourceTypeSchema } from "@rocky/contracts";
import { parserFor } from "../ingest/parsers/index.ts";
import { markdownBlocks, TextBuilder } from "../ingest/parsers/text-blocks.ts";
import type { ParsedDoc, Unit } from "../ingest/types.ts";

/**
 * Turns a connector's normalized document into the ParsedDoc the ingest pipeline chunks. Units
 * keep their anchors (a GitHub comment, a Notion block group, an email message), so the chunker
 * never merges across them and a citation opens the exact item.
 */
export async function toParsedDoc(
  doc: SourceDocument,
): Promise<{ parsed: ParsedDoc; bytes?: Uint8Array }> {
  const sourceType: SourceType = SourceTypeSchema.catch("text").parse(doc.sourceType);
  if (doc.body.kind === "binary") {
    const parser = parserFor(doc.body.filename);
    if (!parser)
      throw new Error(`No parser for ${path.extname(doc.body.filename) || doc.body.filename}`);
    const bytes = await doc.body.fetch();
    const parsed = await parser.parse({ bytes, filename: doc.body.filename });
    return { parsed: { ...parsed, title: doc.title || parsed.title }, bytes };
  }

  const b = new TextBuilder();
  const units: Unit[] = [];
  const pushUnit = (anchor: Unit["anchor"], heading: string | undefined, text: string) => {
    const first = b.blocks.length;
    if (heading) b.add("heading", heading, 2);
    const { text: t, blocks } = markdownBlocks(text);
    for (const blk of blocks)
      b.add(
        blk.type,
        t.slice(blk.start, blk.end),
        blk.type === "heading" ? (blk.level ?? 2) : undefined,
      );
    const added = b.blocks.slice(first);
    const start = added[0]?.start;
    const end = added.at(-1)?.end;
    if (start === undefined || end === undefined) return;
    units.push({ anchor, start, end, blocks: added });
  };
  if (doc.body.units?.length) {
    for (const u of doc.body.units) pushUnit(u.anchor, u.heading, u.text);
  } else {
    pushUnit({ kind: "text" }, undefined, doc.body.text ?? "");
  }
  return { parsed: { title: doc.title, sourceType, text: b.text, units } };
}

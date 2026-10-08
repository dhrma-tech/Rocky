import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendAudit } from "../audit/append.ts";
import { deleteData } from "../deletion/service.ts";
import { ingestFile } from "../ingest/ingest-file.ts";
import type { Db } from "../store/db.ts";

/**
 * First-run sample workspace (roadmap A9): a small fictional dataset so the first cited answer
 * comes in minutes, before importing anything. It lives under its own connector id, so removing
 * it is one deletion and it never mixes with the user's sources.
 */

export const SAMPLE_CONNECTOR = "sample";
export const SAMPLE_DIR = fileURLToPath(new URL("../../../../samples/workspace/", import.meta.url));

/** The guided tour: what to ask, and what a good answer cites. The last one has no answer. */
export const SAMPLE_TOUR: { question: string; expect: string }[] = [
  {
    question: "What did we decide about the subscription price?",
    expect: "18 EUR for two bags a month, from the launch sync and the pricing plan.",
  },
  {
    question: "When will Lena send the checkout mockups?",
    expect: "By Monday 13 October, from Lena's email.",
  },
  {
    question: "How much will green coffee cost from December?",
    expect: "6.85 EUR per kilo for the washed Catuaí, from the supplier's email.",
  },
  {
    question: "What is our marketing budget for Japan?",
    expect: "Not found in your sources: nothing in the sample mentions it.",
  },
];

export function sampleLoaded(db: Db): boolean {
  return Boolean(
    db.prepare("select 1 from documents where connector_id = ? limit 1").get(SAMPLE_CONNECTOR),
  );
}

export async function loadSampleWorkspace(
  db: Db,
  blobsDir: string,
  dir = SAMPLE_DIR,
): Promise<{ documents: number }> {
  let documents = 0;
  for (const f of fs.readdirSync(dir).sort()) {
    if (f === "README.md") continue;
    const r = await ingestFile(db, blobsDir, path.join(dir, f), {
      connectorId: SAMPLE_CONNECTOR,
      meta: { sample: true },
    });
    if (r.status !== "skipped") documents++;
  }
  appendAudit(db, { eventType: "sample_loaded", actor: "user", meta: { documents } });
  return { documents };
}

export function removeSampleWorkspace(db: Db, blobsDir: string): { documents: number } {
  const r = deleteData(db, blobsDir, { connectorId: SAMPLE_CONNECTOR });
  return { documents: r.documents };
}

/**
 * Questions built from the user's own data, without a model (roadmap A9: "after the user's first
 * import, generate suggested questions from their own data"). Sample documents are left out once
 * real ones exist.
 */
export function suggestedQuestions(db: Db, limit = 3): string[] {
  const real = (
    db
      .prepare("select count(*) as n from documents where connector_id != ?")
      .get(SAMPLE_CONNECTOR) as { n: number }
  ).n;
  if (!real) return sampleLoaded(db) ? SAMPLE_TOUR.slice(0, limit).map((t) => t.question) : [];
  const out: string[] = [];
  const meeting = db
    .prepare("select title from meetings order by coalesce(started_at, 0) desc limit 1")
    .get() as { title: string } | undefined;
  if (meeting?.title) out.push(`What did we decide in "${meeting.title}"?`);
  const owed = db
    .prepare(
      `select e.display_name as who from commitments c
       join entities e on e.id = c.counterparty_entity_id
       where c.status = 'open' order by coalesce(c.deadline, 9e15) limit 1`,
    )
    .get() as { who: string } | undefined;
  if (owed?.who) out.push(`What do I owe ${owed.who}?`);
  const docs = db
    .prepare(
      `select title from documents where connector_id != ? and title != ''
       order by coalesce(updated_at, ingested_at) desc limit 5`,
    )
    .all(SAMPLE_CONNECTOR) as { title: string }[];
  for (const d of docs) {
    if (out.length >= limit) break;
    out.push(`What are the key points of "${d.title}"?`);
  }
  return out.slice(0, limit);
}

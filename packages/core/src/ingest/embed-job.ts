import type { Embedder } from "../router/embed.ts";
import type { Db } from "../store/db.ts";

export const EMBED_JOB = "embed_document";

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/**
 * (Re)embeds every chunk of a document. Embedding happens outside the write transaction
 * (it is slow and networked), then rows are swapped in one transaction. A document deleted
 * meanwhile is skipped.
 */
export async function embedDocument(
  db: Db,
  embedder: Embedder,
  documentId: string,
): Promise<number> {
  const rows = db
    .prepare(
      `select c.seq, c.text, d.source_type, d.created_at from chunks c join documents d on d.id = c.document_id
       where c.document_id = ? order by c.ord`,
    )
    .all(documentId) as {
    seq: number;
    text: string;
    source_type: string;
    created_at: number | null;
  }[];
  if (rows.length === 0) return 0;

  const vectors = await embedder.embed(
    rows.map((r) => r.text),
    "document",
  );

  db.transaction(() => {
    const del = db.prepare("delete from chunks_vec where chunk_seq = ?");
    const ins = db.prepare(
      "insert into chunks_vec (chunk_seq, embedding, source_type, created_at) values (?, ?, ?, ?)",
    );
    const alive = db.prepare("select 1 from chunks where seq = ?");
    rows.forEach((r, i) => {
      const vec = vectors[i];
      if (!vec || !alive.get(r.seq)) return;
      del.run(BigInt(r.seq));
      ins.run(BigInt(r.seq), toBlob(vec), r.source_type, BigInt(r.created_at ?? 0));
    });
  })();
  return rows.length;
}

import type { Knex } from "knex";
import { toVectorLiteral } from "./ingest.js";
import { getEmbeddingProvider, type EmbeddingProvider } from "./provider.js";
import type { RetrievedContext } from "./prompt.js";

export type { RetrievedContext } from "./prompt.js";

/** Default number of chunks to pull before relevance filtering. */
export function ragTopK(): number {
  const n = Number(process.env.RAG_TOP_K ?? 6);
  return Number.isInteger(n) && n > 0 ? n : 6;
}

/**
 * Minimum cosine similarity a chunk must reach to be considered relevant. Chunks
 * below this are dropped; if nothing clears it, the caller treats the question as
 * unanswerable from the knowledge base (insufficient-knowledge path) rather than
 * grounding an answer in weak matches.
 */
export function ragMinScore(): number {
  const n = Number(process.env.RAG_MIN_SCORE ?? 0.2);
  return Number.isFinite(n) ? n : 0.2;
}

export type RetrieveOptions = {
  topK?: number;
  minScore?: number;
  provider?: EmbeddingProvider;
};

type ChunkRow = {
  chunk_id: string;
  document_id: string;
  content: string;
  source_type: string;
  source_id: string | null;
  title: string;
  score: number | string;
};

/**
 * Retrieve the most relevant chunks for a query.
 *
 * The query is embedded with the same provider used at ingestion time, then the
 * nearest chunks are found via pgvector cosine distance (`<=>`) over the HNSW
 * index. Similarity is reported as `1 - distance`; only chunks at or above
 * `minScore` are returned (relevance filtering). The result carries the document
 * and original-module provenance needed to build real citations.
 */
export async function retrieveTopK(db: Knex, query: string, opts: RetrieveOptions = {}): Promise<RetrievedContext[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const provider = opts.provider ?? getEmbeddingProvider();
  const topK = opts.topK ?? ragTopK();
  const minScore = opts.minScore ?? ragMinScore();

  const [embedding] = await provider.embed([trimmed]);
  if (!embedding) return [];
  const vec = toVectorLiteral(embedding);

  const rows = await db("kb_chunks as c")
    .join("kb_documents as d", "c.document_id", "d.id")
    .select(
      "c.id as chunk_id",
      "c.document_id as document_id",
      "c.content as content",
      "d.source_type as source_type",
      "d.source_id as source_id",
      "d.title as title"
    )
    .select(db.raw("1 - (c.embedding <=> ?::vector) as score", [vec]))
    .orderByRaw("c.embedding <=> ?::vector asc", [vec])
    .limit(topK);

  return (rows as ChunkRow[])
    .map((r) => ({
      documentId: r.document_id,
      chunkId: r.chunk_id,
      sourceType: r.source_type,
      sourceId: r.source_id,
      title: r.title,
      content: r.content,
      score: Number(r.score)
    }))
    .filter((c) => c.score >= minScore);
}

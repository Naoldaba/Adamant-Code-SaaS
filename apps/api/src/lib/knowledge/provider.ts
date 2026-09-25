import crypto from "node:crypto";

/**
 * Embedding provider abstraction.
 *
 * Ingestion (and, later, retrieval) depends only on this interface, so the real
 * provider can be swapped without touching the pipeline. For Phase 2 we ship a
 * deterministic, offline `local` provider so that `docker compose up` and the
 * test suite work with no API key. An OpenAI-backed provider can be slotted in
 * behind the same interface during the RAG phase without changing the callers or
 * the `vector(EMBEDDING_DIM)` column type.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

export function embeddingDimension(): number {
  const dim = Number(process.env.EMBEDDING_DIM ?? 1536);
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`EMBEDDING_DIM must be a positive integer (got: ${process.env.EMBEDDING_DIM})`);
  }
  return dim;
}

/**
 * Deterministic, dependency-free embedding via L2-normalized feature hashing.
 *
 * The same text always maps to the same vector (important for reproducible tests
 * and for dedup/debugging), and the output dimension matches the DB column, so a
 * later switch to a real provider does not require a schema change — only
 * re-ingestion.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "local";
  public readonly dimension: number;

  constructor(dimension: number = embeddingDimension()) {
    this.dimension = dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    const tokens = tokenize(text);
    for (const token of tokens) {
      // Two hashed features per token (bucket + sign) reduce collisions.
      const h = hashToken(token);
      const bucket = h % this.dimension;
      const sign = ((h >>> 16) & 1) === 0 ? 1 : -1;
      vec[bucket] += sign;
    }
    return l2normalize(vec);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function hashToken(token: string): number {
  // Stable 32-bit unsigned hash derived from sha256 (deterministic across runs).
  const digest = crypto.createHash("sha256").update(token).digest();
  return digest.readUInt32BE(0);
}

function l2normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * Select the embedding provider for this deployment. Only the deterministic local
 * provider exists in Phase 2; the RAG phase adds the OpenAI branch here.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  return new LocalEmbeddingProvider();
}

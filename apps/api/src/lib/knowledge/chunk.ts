export type Chunk = {
  index: number;
  content: string;
  tokenCount: number;
};

export type ChunkOptions = {
  /** Target chunk size in characters (~4 chars/token → ~500 tokens at 2000). */
  chunkSize?: number;
  /** Overlap in characters carried between adjacent chunks for context. */
  overlap?: number;
};

const DEFAULT_CHUNK_SIZE = 2000;
const DEFAULT_OVERLAP = 200;

/**
 * Split normalized document text into ordered, slightly-overlapping chunks.
 *
 * Splitting is character-based and deterministic (no tokenizer dependency).
 * Boundaries prefer the nearest paragraph/sentence break within the window so
 * chunks stay readable; overlap preserves context across boundaries. Every
 * document yields at least one chunk (even a short one) so it is retrievable.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;

  const normalized = text.trim();
  if (normalized.length === 0) return [];

  if (normalized.length <= chunkSize) {
    return [{ index: 0, content: normalized, tokenCount: estimateTokens(normalized) }];
  }

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);

    // Try to end on a natural boundary within the last 20% of the window.
    if (end < normalized.length) {
      const window = normalized.slice(start, end);
      const boundary = lastBoundary(window, Math.floor(chunkSize * 0.8));
      if (boundary > 0) end = start + boundary;
    }

    const content = normalized.slice(start, end).trim();
    if (content.length > 0) {
      chunks.push({ index, content, tokenCount: estimateTokens(content) });
      index++;
    }

    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

function lastBoundary(window: string, minPos: number): number {
  const candidates = ["\n\n", "\n", ". ", "! ", "? "];
  let best = -1;
  for (const sep of candidates) {
    const pos = window.lastIndexOf(sep);
    if (pos >= minPos && pos + sep.length > best) best = pos + sep.length;
  }
  return best;
}

export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(words, Math.ceil(text.length / 4));
}

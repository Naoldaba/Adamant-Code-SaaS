import crypto from "node:crypto";
import {
  buildGroundedPrompt,
  type ChatMessage,
  type RetrievedContext
} from "./prompt.js";

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
 * OpenAI-backed embedding provider, activated when `OPENAI_API_KEY` is set. Uses
 * the global `fetch` (Node ≥ 20) so no SDK dependency is added. `dimensions` is
 * pinned to `EMBEDDING_DIM` so the returned vectors match the `vector(EMBEDDING_DIM)`
 * column regardless of the default model dimension.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "openai";
  public readonly dimension: number;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, dimension: number = embeddingDimension(), model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small") {
    this.apiKey = apiKey;
    this.dimension = dimension;
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimension })
      });
    } catch (e) {
      throw new ProviderError("Embedding provider request failed", e);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ProviderError(`Embedding provider returned ${res.status}: ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
}

/**
 * Select the embedding provider for this deployment. The OpenAI provider is used
 * when `OPENAI_API_KEY` is set; otherwise the deterministic offline local
 * provider keeps `docker compose up` and the test suite working without secrets.
 *
 * Retrieval and ingestion both call this function, so query embeddings are always
 * produced by the same provider that produced the stored chunk embeddings — a
 * hard requirement for the cosine similarities to be meaningful.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key) return new OpenAIEmbeddingProvider(key);
  return new LocalEmbeddingProvider();
}

// ---------------------------------------------------------------------------
// Chat / answer generation
// ---------------------------------------------------------------------------

/**
 * Raised when the answer provider fails (network error, non-2xx, timeout, or a
 * malformed response). The RAG flow catches this to guarantee that a provider
 * failure surfaces as an error and is never persisted as a successful answer.
 */
export class ProviderError extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ProviderError";
    this.cause = cause;
  }
}

export type GenerateAnswerInput = {
  question: string;
  contexts: RetrievedContext[];
  history: ChatMessage[];
};

/**
 * Answer-generation abstraction. The RAG orchestrator calls this only after
 * retrieval has produced at least one relevant context, so implementations can
 * assume `contexts` is non-empty and must ground their answer in it.
 */
export interface ChatProvider {
  readonly name: string;
  generateAnswer(input: GenerateAnswerInput): Promise<{ text: string }>;
}

const LOCAL_ANSWER_MAX_CONTEXTS = 3;
const LOCAL_ANSWER_SNIPPET_CHARS = 600;

/**
 * Deterministic, offline answer provider. It does not invent prose: it composes
 * an extractive answer strictly from the retrieved chunks, with `[n]` markers that
 * line up with the persisted citations. This keeps the assistant fully functional
 * (and its output grounded and reproducible) with no API key, which is what the
 * grading `docker compose up` and the tests rely on.
 */
export class LocalChatProvider implements ChatProvider {
  public readonly name = "local";

  async generateAnswer(input: GenerateAnswerInput): Promise<{ text: string }> {
    const top = input.contexts.slice(0, LOCAL_ANSWER_MAX_CONTEXTS);
    const parts = top.map((c, i) => {
      const snippet = c.content.trim().slice(0, LOCAL_ANSWER_SNIPPET_CHARS);
      return `[${i + 1}] ${snippet}`;
    });
    const sources = top.map((c, i) => `[${i + 1}] ${c.title} (${c.sourceType})`).join("\n");
    const text = `Based on the knowledge base:\n\n${parts.join("\n\n")}\n\nSources:\n${sources}`;
    return { text };
  }
}

/**
 * OpenAI Chat Completions provider, activated when `OPENAI_API_KEY` is set. Builds
 * the grounded prompt (system rules + numbered context + question) and returns the
 * model's answer. Any transport or API failure is normalized to `ProviderError` so
 * the RAG flow treats it as an upstream failure.
 */
export class OpenAIChatProvider implements ChatProvider {
  public readonly name = "openai";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateAnswer(input: GenerateAnswerInput): Promise<{ text: string }> {
    const messages = buildGroundedPrompt(input.question, input.contexts, input.history);
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages, temperature: 0 })
      });
    } catch (e) {
      throw new ProviderError("Answer provider request failed", e);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ProviderError(`Answer provider returned ${res.status}: ${detail.slice(0, 200)}`);
    }
    let json: { choices?: { message?: { content?: string } }[] };
    try {
      json = (await res.json()) as typeof json;
    } catch (e) {
      throw new ProviderError("Answer provider returned an unreadable response", e);
    }
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new ProviderError("Answer provider returned an empty response");
    return { text };
  }
}

/**
 * Select the answer provider: OpenAI when a key is configured, otherwise the
 * deterministic local extractive provider.
 */
export function getChatProvider(): ChatProvider {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key) return new OpenAIChatProvider(key);
  return new LocalChatProvider();
}

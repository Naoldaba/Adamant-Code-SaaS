/**
 * Shared RAG types and prompt/context construction.
 *
 * This module is intentionally dependency-free (no imports from `provider`,
 * `retrieve`, or `rag`) so it can be imported by all of them without creating an
 * import cycle. It owns the two things every RAG path shares: the shape of a
 * retrieved context, and how retrieved contexts are turned into a grounded prompt.
 */

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/**
 * A single chunk returned by retrieval, carrying the provenance needed both to
 * ground the answer and to build a citation that maps back to a real stored
 * document / original module item.
 */
export type RetrievedContext = {
  documentId: string;
  chunkId: string;
  sourceType: string;
  sourceId: string | null;
  title: string;
  content: string;
  score: number;
};

/**
 * The single, explicit response the assistant returns when retrieval finds
 * nothing relevant. Kept as a constant so the route, the local provider, and the
 * tests all agree on the exact insufficient-knowledge behavior and never emit a
 * fabricated answer instead.
 */
export const INSUFFICIENT_KNOWLEDGE_MESSAGE =
  "I couldn't find anything in the current knowledge base that answers this question. " +
  "Try ingesting the relevant source material (via the Knowledge Uploader) and ask again.";

/**
 * System instruction that constrains the model to the retrieved context. It is
 * deliberately strict: answer only from context, cite sources, and admit when the
 * context is insufficient rather than guessing. This is the primary guard against
 * fabrication for the real (LLM-backed) provider.
 */
export const SYSTEM_PROMPT = [
  "You are the Adamant SaaS Knowledge Assistant.",
  "Answer the user's question using ONLY the numbered context items provided below.",
  "Rules:",
  "- Ground every statement strictly in the provided context. Do not use outside knowledge and do not fabricate.",
  "- Cite the context items you used inline with bracketed numbers like [1] or [2].",
  "- If the context does not contain enough information to answer, reply that you cannot answer from the",
  "  current knowledge base and suggest ingesting the relevant source material. Do not guess.",
  "- Be concise and factual."
].join("\n");

/**
 * Format retrieved contexts into a single numbered block. The numbering is what
 * the model's inline `[n]` citations refer to, and the same ordering is used when
 * persisting `message_citations`, so a citation `[n]` maps to the nth context.
 */
export function buildContextBlock(contexts: RetrievedContext[]): string {
  return contexts
    .map((c, i) => {
      const label = c.sourceType ? `${c.title} — ${c.sourceType}` : c.title;
      return `[${i + 1}] (${label})\n${c.content.trim()}`;
    })
    .join("\n\n");
}

/**
 * Build the full grounded prompt (system + prior turns + the user question with
 * its retrieved context appended). Used by the LLM-backed provider; exported so
 * context construction is testable independently of any network call.
 */
export function buildGroundedPrompt(
  question: string,
  contexts: RetrievedContext[],
  history: ChatMessage[] = []
): ChatMessage[] {
  const contextBlock = buildContextBlock(contexts);
  const userContent = `Context:\n${contextBlock}\n\nQuestion: ${question}`;
  return [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: userContent }];
}

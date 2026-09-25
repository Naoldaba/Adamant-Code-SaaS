import type { Knex } from "knex";
import { retrieveTopK, type RetrieveOptions } from "./retrieve.js";
import {
  getChatProvider,
  ProviderError,
  type ChatProvider,
  type EmbeddingProvider
} from "./provider.js";
import { INSUFFICIENT_KNOWLEDGE_MESSAGE, type ChatMessage, type RetrievedContext } from "./prompt.js";

const CITATION_SNIPPET_CHARS = 300;
const AUTO_NAME_MAX_CHARS = 60;
const DEFAULT_CONVERSATION_TITLE = "New conversation";

export type PersistedMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "error";
  created_at: string;
};

export type CitationOut = {
  id: string;
  documentId: string | null;
  chunkId: string | null;
  sourceType: string;
  sourceId: string | null;
  title: string;
  score: number;
  snippet: string | null;
};

export type CreateAnswerResult = {
  userMessage: PersistedMessage;
  message: PersistedMessage;
  citations: CitationOut[];
  insufficient: boolean;
};

export type CreateAnswerParams = {
  conversationId: string;
  userId: string;
  question: string;
  embeddingProvider?: EmbeddingProvider;
  chatProvider?: ChatProvider;
  retrieve?: RetrieveOptions;
};

/**
 * Reduce retrieved chunks to one citation per source document, keeping the
 * highest-scoring chunk. A document can produce several nearby chunks; collapsing
 * them avoids showing the same source multiple times while preserving the best
 * evidence snippet.
 */
export function dedupeContextsByDocument(contexts: RetrievedContext[]): RetrievedContext[] {
  const best = new Map<string, RetrievedContext>();
  for (const c of contexts) {
    const existing = best.get(c.documentId);
    if (!existing || c.score > existing.score) best.set(c.documentId, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

function autoTitle(question: string): string {
  const collapsed = question.trim().replace(/\s+/g, " ");
  if (collapsed.length <= AUTO_NAME_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, AUTO_NAME_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Run the full RAG turn for one user question inside a conversation.
 *
 * Ownership is enforced against `userId` (never a client-supplied id); a missing
 * or foreign conversation returns `null` so the route can answer 404. The user
 * message is always persisted. Retrieval + relevance filtering then decide the
 * path:
 *  - nothing relevant  → an explicit insufficient-knowledge answer with NO
 *    citations (no fabrication).
 *  - relevant context  → the provider generates a grounded answer; on success the
 *    assistant message and its citations are written in a single transaction.
 *
 * Provider failure is the critical case: the assistant message is recorded with
 * `status = "error"` (never `complete`) and a `ProviderError` is re-thrown, so a
 * failed/partial answer is never stored or returned as successful.
 */
export async function createAnswer(db: Knex, params: CreateAnswerParams): Promise<CreateAnswerResult | null> {
  const { conversationId, userId, question } = params;

  const conversation = await db("conversations")
    .select("id", "user_id", "title")
    .where({ id: conversationId })
    .first();
  if (!conversation || conversation.user_id !== userId) return null;

  // Persist the user turn first so it survives even if generation later fails.
  const [userMessage] = await db("messages")
    .insert({ conversation_id: conversationId, role: "user", content: question, status: "complete" })
    .returning<PersistedMessage[]>(["id", "conversation_id", "role", "content", "status", "created_at"]);

  // Auto-name the conversation from the first user message if still untitled.
  if (conversation.title === DEFAULT_CONVERSATION_TITLE) {
    await db("conversations").where({ id: conversationId }).update({ title: autoTitle(question) });
  }

  const retrieveOpts: RetrieveOptions = {
    ...params.retrieve,
    provider: params.retrieve?.provider ?? params.embeddingProvider
  };
  const contexts = await retrieveTopK(db, question, retrieveOpts);

  // Insufficient knowledge: return the explicit response, store no citations.
  if (contexts.length === 0) {
    const [assistant] = await db("messages")
      .insert({
        conversation_id: conversationId,
        role: "assistant",
        content: INSUFFICIENT_KNOWLEDGE_MESSAGE,
        status: "complete"
      })
      .returning<PersistedMessage[]>(["id", "conversation_id", "role", "content", "status", "created_at"]);
    await db("conversations").where({ id: conversationId }).update({ updated_at: db.fn.now() });
    return { userMessage, message: assistant, citations: [], insufficient: true };
  }

  const cited = dedupeContextsByDocument(contexts);
  const chatProvider = params.chatProvider ?? getChatProvider();

  const history = await loadHistory(db, conversationId, userMessage.id);

  let answerText: string;
  try {
    const result = await chatProvider.generateAnswer({ question, contexts: cited, history });
    answerText = result.text;
  } catch (e) {
    // Upstream failure: record an explicit error turn (never `complete`) and
    // re-throw so the route returns an error and no partial answer is surfaced.
    const errorDetail = e instanceof Error ? e.message : "Answer generation failed";
    await db("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: "",
      status: "error",
      error_json: JSON.stringify({ message: errorDetail })
    });
    await db("conversations").where({ id: conversationId }).update({ updated_at: db.fn.now() });
    throw e instanceof ProviderError ? e : new ProviderError(errorDetail, e);
  }

  // Success: persist the assistant message + its citations atomically.
  const { message, citations } = await db.transaction(async (trx) => {
    const [assistant] = await trx("messages")
      .insert({ conversation_id: conversationId, role: "assistant", content: answerText, status: "complete" })
      .returning<PersistedMessage[]>(["id", "conversation_id", "role", "content", "status", "created_at"]);

    const citationRows = cited.map((c) => ({
      message_id: assistant.id,
      document_id: c.documentId,
      chunk_id: c.chunkId,
      source_type: c.sourceType,
      source_id: c.sourceId,
      title: c.title,
      score: c.score,
      snippet: c.content.trim().slice(0, CITATION_SNIPPET_CHARS)
    }));

    let inserted: CitationRow[] = [];
    if (citationRows.length > 0) {
      inserted = await trx("message_citations")
        .insert(citationRows)
        .returning<CitationRow[]>([
          "id",
          "document_id",
          "chunk_id",
          "source_type",
          "source_id",
          "title",
          "score",
          "snippet"
        ]);
    }

    await trx("conversations").where({ id: conversationId }).update({ updated_at: trx.fn.now() });
    return { message: assistant, citations: inserted.map(toCitationOut) };
  });

  return { userMessage, message, citations, insufficient: false };
}

type CitationRow = {
  id: string;
  document_id: string | null;
  chunk_id: string | null;
  source_type: string;
  source_id: string | null;
  title: string;
  score: number | string;
  snippet: string | null;
};

export function toCitationOut(row: CitationRow): CitationOut {
  return {
    id: row.id,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    title: row.title,
    score: Number(row.score),
    snippet: row.snippet
  };
}

/**
 * Load prior complete turns (excluding the just-inserted user message) as chat
 * history so the provider has conversational context. Error turns are skipped so a
 * past failure never leaks into a new prompt.
 */
async function loadHistory(db: Knex, conversationId: string, excludeMessageId: string): Promise<ChatMessage[]> {
  const rows = await db("messages")
    .select("role", "content")
    .where({ conversation_id: conversationId, status: "complete" })
    .whereNot({ id: excludeMessageId })
    .orderBy("created_at", "asc");
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

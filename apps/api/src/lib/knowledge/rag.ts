import type { Knex } from "knex";
import { retrieveTopK, type RetrieveOptions } from "./retrieve.js";
import {
  getChatProvider,
  ProviderError,
  streamChatAnswer,
  type ChatProvider,
  type EmbeddingProvider
} from "./provider.js";
import { INSUFFICIENT_KNOWLEDGE_MESSAGE, type ChatMessage, type RetrievedContext } from "./prompt.js";

const CITATION_SNIPPET_CHARS = 300;
const AUTO_NAME_MAX_CHARS = 60;
const DEFAULT_CONVERSATION_TITLE = "New conversation";
// User-facing message when generation fails. Kept identical to the non-streaming
// route's 502 body so the streaming and non-streaming paths report failures the
// same way; the underlying detail is persisted in the error turn's error_json.
export const PROVIDER_FAILURE_MESSAGE = "The answer provider failed. Please try again.";
// Cap how many prior turns are replayed into the grounded prompt. Without a bound
// a long conversation grows the prompt until it hits the provider's context/cost
// limits (and starts failing); the most recent turns carry the relevant context.
const MAX_HISTORY_MESSAGES = 10;

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
  const prepared = await prepareAnswer(db, params);
  if (prepared.kind === "not_found") return null;
  if (prepared.kind === "insufficient") {
    return { userMessage: prepared.userMessage, message: prepared.message, citations: [], insufficient: true };
  }

  const { userMessage, cited, chatProvider, history } = prepared;
  let answerText: string;
  try {
    const result = await chatProvider.generateAnswer({ question: params.question, contexts: cited, history });
    answerText = result.text;
  } catch (e) {
    // Upstream failure: record an explicit error turn (never `complete`) and
    // re-throw so the route returns an error and no partial answer is surfaced.
    const errorDetail = e instanceof Error ? e.message : "Answer generation failed";
    await persistErrorTurn(db, params.conversationId, errorDetail);
    throw e instanceof ProviderError ? e : new ProviderError(errorDetail, e);
  }

  const { message, citations } = await persistCompletedAnswer(db, params.conversationId, cited, answerText);
  return { userMessage, message, citations, insufficient: false };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type StreamAnswerParams = CreateAnswerParams & { signal?: AbortSignal };

/**
 * Events emitted by {@link streamAnswer}, in order. `not_found` is only ever the
 * sole event (ownership failed, nothing persisted). Otherwise the sequence is:
 * `user` → either `insufficient` (guardrail: no LLM stream started) or zero-or-more
 * `delta` followed by `done`. `error` replaces `done` on provider failure. On
 * client disconnect the generator returns after `user`/`delta`s with no terminal
 * event and persists nothing as complete.
 */
export type AnswerStreamEvent =
  | { type: "not_found" }
  | { type: "user"; userMessage: PersistedMessage }
  | { type: "insufficient"; message: PersistedMessage }
  | { type: "delta"; text: string }
  | { type: "done"; message: PersistedMessage; citations: CitationOut[] }
  | { type: "error"; message: string };

/**
 * Streaming counterpart of {@link createAnswer}. The pre-LLM pipeline is identical
 * and shared via {@link prepareAnswer} (ownership → persist user → auto-name →
 * retrieve → grounding threshold); streaming begins only after those pass.
 *
 * Guardrails preserved:
 *  - insufficient retrieval yields the canned response with NO `delta` stream and
 *    no citations (no LLM call is made).
 *  - provider failure records a `status:"error"` turn (never `complete`) and yields
 *    an `error` event — a partial/failed answer is never stored as successful.
 *  - a client disconnect (`signal` aborted) stops generation and persists nothing,
 *    so a partial answer for a gone client is never saved as complete.
 * Only the fully-accumulated answer is persisted, with its citations, after the
 * stream completes successfully.
 */
export async function* streamAnswer(db: Knex, params: StreamAnswerParams): AsyncGenerator<AnswerStreamEvent> {
  const prepared = await prepareAnswer(db, params);
  if (prepared.kind === "not_found") {
    yield { type: "not_found" };
    return;
  }

  yield { type: "user", userMessage: prepared.userMessage };

  if (prepared.kind === "insufficient") {
    yield { type: "insufficient", message: prepared.message };
    return;
  }

  const { cited, chatProvider, history } = prepared;
  const signal = params.signal;
  let full = "";
  try {
    for await (const delta of streamChatAnswer(chatProvider, { question: params.question, contexts: cited, history }, signal)) {
      if (signal?.aborted) return; // client disconnected: stop, persist nothing
      if (!delta) continue;
      full += delta;
      yield { type: "delta", text: delta };
    }
  } catch (e) {
    if (signal?.aborted) return; // aborted due to disconnect: cleanup only
    const errorDetail = e instanceof Error ? e.message : "Answer generation failed";
    await persistErrorTurn(db, params.conversationId, errorDetail);
    yield { type: "error", message: PROVIDER_FAILURE_MESSAGE };
    return;
  }

  if (signal?.aborted) return;

  // A successful-but-empty stream is treated as a provider failure: never persist
  // an empty answer as a complete assistant message.
  if (full.trim().length === 0) {
    await persistErrorTurn(db, params.conversationId, "Answer provider returned an empty response");
    yield { type: "error", message: PROVIDER_FAILURE_MESSAGE };
    return;
  }

  const { message, citations } = await persistCompletedAnswer(db, params.conversationId, cited, full);
  yield { type: "done", message, citations };
}

// ---------------------------------------------------------------------------
// Shared pipeline helpers (used by both the streaming and non-streaming paths)
// ---------------------------------------------------------------------------

type PreparedAnswer =
  | { kind: "not_found" }
  | { kind: "insufficient"; userMessage: PersistedMessage; message: PersistedMessage }
  | {
      kind: "generate";
      userMessage: PersistedMessage;
      cited: RetrievedContext[];
      chatProvider: ChatProvider;
      history: ChatMessage[];
    };

/**
 * Run the shared pre-generation pipeline for one question: enforce ownership
 * (against `userId`, never a client id), persist the user turn, auto-name the
 * conversation, retrieve + relevance-filter context, and decide the path. The
 * insufficient-knowledge turn is persisted here so both entry points behave
 * identically up to the point an LLM would be called.
 */
async function prepareAnswer(db: Knex, params: CreateAnswerParams): Promise<PreparedAnswer> {
  const { conversationId, userId, question } = params;

  const conversation = await db("conversations")
    .select("id", "user_id", "title")
    .where({ id: conversationId })
    .first();
  if (!conversation || conversation.user_id !== userId) return { kind: "not_found" };

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

  // Insufficient knowledge: persist the explicit response, store no citations.
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
    return { kind: "insufficient", userMessage, message: assistant };
  }

  const cited = dedupeContextsByDocument(contexts);
  const chatProvider = params.chatProvider ?? getChatProvider();
  const history = await loadHistory(db, conversationId, userMessage.id);

  return { kind: "generate", userMessage, cited, chatProvider, history };
}

/**
 * Persist a completed assistant answer and its citations atomically, and bump the
 * conversation's activity timestamp. Citations snapshot the source metadata so they
 * remain meaningful even if the underlying document is later re-ingested or deleted.
 */
async function persistCompletedAnswer(
  db: Knex,
  conversationId: string,
  cited: RetrievedContext[],
  answerText: string
): Promise<{ message: PersistedMessage; citations: CitationOut[] }> {
  return db.transaction(async (trx) => {
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
}

/**
 * Record a provider/generation failure as an explicit assistant turn with
 * `status:"error"` (never `complete`) so the UI never renders it as an answer, and
 * bump the conversation timestamp. The user turn persisted earlier is kept.
 */
async function persistErrorTurn(db: Knex, conversationId: string, errorDetail: string): Promise<void> {
  await db("messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content: "",
    status: "error",
    error_json: JSON.stringify({ message: errorDetail })
  });
  await db("conversations").where({ id: conversationId }).update({ updated_at: db.fn.now() });
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
    .orderBy("created_at", "desc")
    .limit(MAX_HISTORY_MESSAGES);
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }))
    .reverse();
}

import express, { Router } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { offsetLimit, paginationQuerySchema } from "../lib/pagination.js";
import { parseJsonl } from "../lib/knowledge/parseJsonl.js";
import { runIngestion } from "../lib/knowledge/ingest.js";
import { KNOWLEDGE_TYPES } from "../lib/knowledge/normalize.js";
import { maxUploadBytes, validateUpload } from "../lib/knowledge/uploadValidation.js";
import { createAnswer, toCitationOut } from "../lib/knowledge/rag.js";
import { ProviderError } from "../lib/knowledge/provider.js";

export const assistantRouter = Router();

// Raw-text body parser scoped to the upload route only. The file is sent as the
// raw request body (content-type text/plain) so it bypasses the global 1 MB JSON
// parser; the large hard cap here is only a memory safety net — the real,
// user-facing size limit (KB_MAX_UPLOAD_MB) is enforced with a clear message in
// the handler via validateUpload.
const uploadBodyParser = express.text({ type: () => true, limit: "64mb" });

function isKnowledgeType(type: string): boolean {
  return (KNOWLEDGE_TYPES as readonly string[]).includes(type);
}

function ingestionResponse(result: {
  ingestionId: string;
  status: string;
  stats: unknown;
  errors: unknown;
}) {
  return {
    ingestion: {
      id: result.ingestionId,
      status: result.status,
      stats: result.stats,
      errors: result.errors
    }
  };
}

// POST /assistant/knowledge/ingest?filename=foo.jsonl — admin-only file upload.
// The JSONL file content is the raw request body.
assistantRouter.post(
  "/knowledge/ingest",
  requireAuth,
  requireRole("admin"),
  uploadBodyParser,
  async (req, res, next) => {
    try {
      const db = req.db!;
      const filename = typeof req.query.filename === "string" ? req.query.filename : null;
      const content = typeof req.body === "string" ? req.body : "";

      const validation = validateUpload({ filename, content, maxBytes: maxUploadBytes() });
      if (!validation.ok) {
        throw new ApiError(400, "VALIDATION_ERROR", validation.message);
      }

      const { records, errors } = parseJsonl(content);

      // If every non-blank line is malformed, there is nothing to ingest.
      if (records.length === 0) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          errors.length > 0
            ? `No valid JSON lines found. First error — line ${errors[0].line}: ${errors[0].error}`
            : "No content to ingest."
        );
      }

      const result = await runIngestion(db, {
        records,
        parseErrors: errors,
        filename,
        source: "upload",
        uploadedBy: req.user!.id
      });

      const status = result.status === "succeeded" ? 200 : 502;
      res.status(status).json({ data: ingestionResponse(result) });
    } catch (e) {
      next(e);
    }
  }
);

// POST /assistant/knowledge/ingest/from-module/:type — admin-only. Ingest an
// existing module directly from the DB (same rows the JSONL export would emit),
// convenient for the "ingest all modules" scenario.
assistantRouter.post(
  "/knowledge/ingest/from-module/:type",
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const db = req.db!;
      const { type } = req.params;
      if (!isKnowledgeType(type)) {
        throw new ApiError(400, "VALIDATION_ERROR", `Invalid module type: ${type}`);
      }

      const rows = await db("knowledge_items").select("*").where({ type }).orderBy("updated_at", "desc");
      if (rows.length === 0) {
        throw new ApiError(404, "NOT_FOUND", `No items found for module type: ${type}`);
      }

      // Mirror the export path: each record is a full knowledge_items row.
      const records = rows.map((row, i) => ({ line: i + 1, data: row }));

      const result = await runIngestion(db, {
        records,
        parseErrors: [],
        filename: `${type} (module)`,
        source: "module",
        uploadedBy: req.user!.id
      });

      const status = result.status === "succeeded" ? 200 : 502;
      res.status(status).json({ data: ingestionResponse(result) });
    } catch (e) {
      next(e);
    }
  }
);

// GET /assistant/knowledge/ingestions — admin-only run history (insert/update/
// skip/failure counts + per-line errors for each run).
assistantRouter.get("/knowledge/ingestions", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const db = req.db!;
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const items = await db("kb_ingestions").select("*").orderBy("created_at", "desc").limit(limit);
    res.json({ data: { items } });
  } catch (e) {
    next(e);
  }
});

// GET /assistant/knowledge/documents — ingested KB summary (per source type +
// totals). Available to any authenticated user; the KB is global/shared.
assistantRouter.get("/knowledge/documents", requireAuth, async (req, res, next) => {
  try {
    const db = req.db!;
    const byType = await db("kb_documents")
      .select("source_type")
      .count<{ source_type: string; count: string }[]>({ count: "*" })
      .groupBy("source_type");

    const counts: Record<string, number> = {};
    let totalDocuments = 0;
    for (const row of byType) {
      const n = Number(row.count);
      counts[row.source_type] = n;
      totalDocuments += n;
    }

    const chunkRow = await db("kb_chunks").count<{ count: string }[]>({ count: "*" }).first();
    const totalChunks = Number(chunkRow?.count ?? 0);

    res.json({ data: { counts, totalDocuments, totalChunks } });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Conversations + RAG chat
//
// Conversations belong to the authenticated user; ownership is always enforced
// against req.user.id (never a client-supplied id). Full lifecycle: create, list
// (own, newest activity first), open (messages + citations), continue (ask),
// rename, delete. Auto-naming happens on the first user message (see rag.ts).
// ---------------------------------------------------------------------------

const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional()
});

const renameConversationSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200)
});

const askSchema = z.object({
  content: z.string().trim().min(1, "Message content is required").max(4000)
});

// GET /assistant/conversations — list the current user's conversations, ordered
// by most recent activity. Scoped to req.user.id so a user only ever sees their
// own conversations. Each row carries its message_count for the sidebar.
assistantRouter.get("/conversations", requireAuth, validateQuery(paginationQuerySchema), async (req, res, next) => {
  try {
    const db = req.db!;
    const q = req.query as unknown as z.infer<typeof paginationQuerySchema>;
    const { offset, limit } = offsetLimit(q);

    const totalRow = await db("conversations")
      .where({ user_id: req.user!.id })
      .count<{ count: string }[]>({ count: "*" })
      .first();
    const total = Number(totalRow?.count ?? 0);

    const items = await db("conversations")
      .select("id", "title", "created_at", "updated_at")
      .where({ user_id: req.user!.id })
      .orderBy("updated_at", "desc")
      .offset(offset)
      .limit(limit);

    // Attach message counts with a single grouped query (mirrors the citation
    // merge in the open endpoint) rather than an N+1 per conversation.
    const ids = items.map((c) => c.id);
    const countRows = ids.length
      ? await db("messages")
          .select("conversation_id")
          .count<{ conversation_id: string; count: string }[]>({ count: "*" })
          .whereIn("conversation_id", ids)
          .groupBy("conversation_id")
      : [];
    const countByConversation = new Map(countRows.map((r) => [r.conversation_id, Number(r.count)]));

    const withCounts = items.map((c) => ({ ...c, messageCount: countByConversation.get(c.id) ?? 0 }));

    res.json({ data: { items: withCounts, page: q.page, pageSize: q.pageSize, total } });
  } catch (e) {
    next(e);
  }
});

// POST /assistant/conversations — create a conversation for the current user.
assistantRouter.post("/conversations", requireAuth, validateBody(createConversationSchema), async (req, res, next) => {
  try {
    const db = req.db!;
    const body = req.body as z.infer<typeof createConversationSchema>;
    const insert: Record<string, unknown> = { user_id: req.user!.id };
    if (body.title) insert.title = body.title;

    const [conversation] = await db("conversations")
      .insert(insert)
      .returning<{ id: string; title: string; created_at: string; updated_at: string }[]>([
        "id",
        "title",
        "created_at",
        "updated_at"
      ]);

    res.status(201).json({ data: { conversation } });
  } catch (e) {
    next(e);
  }
});

// GET /assistant/conversations/:id — open a conversation: messages in
// chronological order, each with its citations. Owner-only.
assistantRouter.get("/conversations/:id", requireAuth, async (req, res, next) => {
  try {
    const db = req.db!;
    const conversation = await db("conversations")
      .select("id", "user_id", "title", "created_at", "updated_at")
      .where({ id: req.params.id })
      .first();
    if (!conversation || conversation.user_id !== req.user!.id) {
      throw new ApiError(404, "NOT_FOUND", "Conversation not found");
    }

    const messages = await db("messages")
      .select("id", "role", "content", "status", "created_at")
      .where({ conversation_id: conversation.id })
      .orderBy("created_at", "asc");

    const messageIds = messages.map((m) => m.id);
    const citationRows = messageIds.length
      ? await db("message_citations")
          .select(
            "id",
            "message_id",
            "document_id",
            "chunk_id",
            "source_type",
            "source_id",
            "title",
            "score",
            "snippet"
          )
          .whereIn("message_id", messageIds)
          .orderBy("score", "desc")
      : [];

    const citationsByMessage = new Map<string, ReturnType<typeof toCitationOut>[]>();
    for (const row of citationRows) {
      const list = citationsByMessage.get(row.message_id) ?? [];
      list.push(toCitationOut(row));
      citationsByMessage.set(row.message_id, list);
    }

    const withCitations = messages.map((m) => ({
      ...m,
      citations: citationsByMessage.get(m.id) ?? []
    }));

    const { user_id: _omit, ...conversationOut } = conversation;
    res.json({ data: { conversation: conversationOut, messages: withCitations } });
  } catch (e) {
    next(e);
  }
});

// POST /assistant/conversations/:id/messages — ask a question (RAG). Owner-only.
// On provider failure returns 502 and does not persist a successful answer.
assistantRouter.post(
  "/conversations/:id/messages",
  requireAuth,
  validateBody(askSchema),
  async (req, res, next) => {
    try {
      const db = req.db!;
      const { content } = req.body as z.infer<typeof askSchema>;

      const result = await createAnswer(db, {
        conversationId: req.params.id,
        userId: req.user!.id,
        question: content
      });
      if (result === null) throw new ApiError(404, "NOT_FOUND", "Conversation not found");

      res.status(201).json({
        data: {
          userMessage: result.userMessage,
          message: result.message,
          citations: result.citations,
          insufficient: result.insufficient
        }
      });
    } catch (e) {
      if (e instanceof ProviderError) {
        return next(new ApiError(502, "INTERNAL_ERROR", "The answer provider failed. Please try again."));
      }
      next(e);
    }
  }
);

// PATCH /assistant/conversations/:id — rename a conversation. Owner-only: the
// update is scoped by user_id so another user cannot rename it, and a foreign or
// missing conversation yields 404 (never leaks existence). updated_at is left
// untouched so a rename does not reorder the activity-sorted list.
assistantRouter.patch(
  "/conversations/:id",
  requireAuth,
  validateBody(renameConversationSchema),
  async (req, res, next) => {
    try {
      const db = req.db!;
      const { title } = req.body as z.infer<typeof renameConversationSchema>;

      const updated = await db("conversations")
        .where({ id: req.params.id, user_id: req.user!.id })
        .update({ title })
        .returning<{ id: string; title: string; created_at: string; updated_at: string }[]>([
          "id",
          "title",
          "created_at",
          "updated_at"
        ]);
      if (!updated[0]) throw new ApiError(404, "NOT_FOUND", "Conversation not found");

      res.json({ data: { conversation: updated[0] } });
    } catch (e) {
      next(e);
    }
  }
);

// DELETE /assistant/conversations/:id — delete a conversation. Owner-only via the
// user_id scope; messages and message_citations cascade (FK on delete cascade).
assistantRouter.delete("/conversations/:id", requireAuth, async (req, res, next) => {
  try {
    const db = req.db!;
    const deleted = await db("conversations").where({ id: req.params.id, user_id: req.user!.id }).del();
    if (deleted === 0) throw new ApiError(404, "NOT_FOUND", "Conversation not found");

    res.json({ data: { id: req.params.id } });
  } catch (e) {
    next(e);
  }
});

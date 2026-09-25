import express, { Router } from "express";
import { ApiError } from "../lib/errors.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { parseJsonl } from "../lib/knowledge/parseJsonl.js";
import { runIngestion } from "../lib/knowledge/ingest.js";
import { KNOWLEDGE_TYPES } from "../lib/knowledge/normalize.js";
import { maxUploadBytes, validateUpload } from "../lib/knowledge/uploadValidation.js";

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

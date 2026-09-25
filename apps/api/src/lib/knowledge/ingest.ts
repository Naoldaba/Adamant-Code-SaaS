import type { Knex } from "knex";
import { chunkText } from "./chunk.js";
import { exportRowSchema, normalizeExportRow, type NormalizedDocument } from "./normalize.js";
import type { LineError, ParsedLine } from "./parseJsonl.js";
import { getEmbeddingProvider, type EmbeddingProvider } from "./provider.js";

export type IngestionStats = {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
};

export type ValidatedRecords = {
  valid: { line: number; doc: NormalizedDocument }[];
  errors: LineError[];
};

/**
 * Validate parsed JSONL records against the export-row schema and normalize the
 * valid ones. Invalid lines are collected as `{ line, error }` (skip-and-report)
 * so the caller can surface exactly which lines failed and why.
 */
export function validateAndNormalize(
  records: ParsedLine[],
  extraMetadata: Record<string, unknown> = {}
): ValidatedRecords {
  const valid: { line: number; doc: NormalizedDocument }[] = [];
  const errors: LineError[] = [];

  for (const rec of records) {
    const parsed = exportRowSchema.safeParse(rec.data);
    if (!parsed.success) {
      errors.push({ line: rec.line, error: firstIssue(parsed.error) });
      continue;
    }
    valid.push({ line: rec.line, doc: normalizeExportRow(parsed.data, extraMetadata) });
  }

  return { valid, errors };
}

function firstIssue(error: import("zod").ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid record";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export type IngestionAction = "insert" | "update" | "skip";

/**
 * Decide what a repeated ingest should do for one document, so uploads update
 * rather than silently duplicate:
 *  - no existing document with the same natural key → insert
 *  - existing document, same content hash → skip (unchanged)
 *  - existing document, changed content hash → update (re-chunk + re-embed)
 */
export function classifyDocument(existingContentHash: string | null | undefined, newContentHash: string): IngestionAction {
  if (!existingContentHash) return "insert";
  return existingContentHash === newContentHash ? "skip" : "update";
}

export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export type RunIngestionParams = {
  records: ParsedLine[];
  parseErrors: LineError[];
  filename: string | null;
  source: "upload" | "module";
  uploadedBy: string | null;
  provider?: EmbeddingProvider;
};

export type RunIngestionResult = {
  ingestionId: string;
  status: "succeeded" | "failed";
  stats: IngestionStats;
  errors: LineError[];
};

/**
 * Orchestrate a full ingestion run.
 *
 * A `kb_ingestions` row is created up front (status `running`) so the run is
 * always tracked. All document/chunk writes happen inside a single transaction,
 * so nothing becomes visible to retrieval until the run commits — this is what
 * makes uploaded content "searchable only after successful ingestion". On an
 * unrecoverable error the transaction rolls back and the run is marked `failed`,
 * contributing nothing to the knowledge base.
 */
export async function runIngestion(db: Knex, params: RunIngestionParams): Promise<RunIngestionResult> {
  const provider = params.provider ?? getEmbeddingProvider();
  const { valid, errors: validationErrors } = validateAndNormalize(params.records, {
    filename: params.filename
  });
  const errors: LineError[] = [...params.parseErrors, ...validationErrors].sort((a, b) => a.line - b.line);

  const [ingestion] = await db("kb_ingestions")
    .insert({
      filename: params.filename,
      source: params.source,
      status: "running",
      uploaded_by: params.uploadedBy,
      stats_json: JSON.stringify({ total: 0, inserted: 0, updated: 0, skipped: 0, failed: errors.length }),
      errors_json: JSON.stringify(errors)
    })
    .returning<{ id: string }[]>("id");

  const ingestionId = ingestion.id;

  const stats: IngestionStats = {
    total: params.records.length + params.parseErrors.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: errors.length
  };

  try {
    await db.transaction(async (trx) => {
      for (const { doc } of valid) {
        const existing = doc.sourceId
          ? await trx("kb_documents")
              .select("id", "content_hash")
              .where({ source_type: doc.sourceType, source_id: doc.sourceId })
              .first()
          : await trx("kb_documents").select("id", "content_hash").where({ content_hash: doc.contentHash }).first();

        const action = classifyDocument(existing?.content_hash, doc.contentHash);
        if (action === "skip") {
          stats.skipped++;
          continue;
        }

        let documentId: string;
        if (action === "update") {
          documentId = existing!.id;
          await trx("kb_documents")
            .where({ id: documentId })
            .update({
              title: doc.title,
              content: doc.content,
              metadata_json: JSON.stringify(doc.metadataJson),
              content_hash: doc.contentHash,
              ingestion_id: ingestionId,
              updated_at: trx.fn.now()
            });
          await trx("kb_chunks").where({ document_id: documentId }).del();
          stats.updated++;
        } else {
          const [inserted] = await trx("kb_documents")
            .insert({
              source_type: doc.sourceType,
              source_id: doc.sourceId,
              title: doc.title,
              content: doc.content,
              metadata_json: JSON.stringify(doc.metadataJson),
              content_hash: doc.contentHash,
              ingestion_id: ingestionId
            })
            .returning<{ id: string }[]>("id");
          documentId = inserted.id;
          stats.inserted++;
        }

        const chunks = chunkText(doc.content);
        if (chunks.length === 0) continue;
        const embeddings = await provider.embed(chunks.map((c) => c.content));

        const chunkRows = chunks.map((c, i) => ({
          document_id: documentId,
          chunk_index: c.index,
          content: c.content,
          token_count: c.tokenCount,
          embedding: db.raw("?::vector", [toVectorLiteral(embeddings[i])]),
          metadata_json: JSON.stringify({ title: doc.title })
        }));
        await trx("kb_chunks").insert(chunkRows);
      }
    });
  } catch (e) {
    await db("kb_ingestions")
      .where({ id: ingestionId })
      .update({
        status: "failed",
        stats_json: JSON.stringify(stats),
        errors_json: JSON.stringify([
          ...errors,
          { line: 0, error: e instanceof Error ? e.message : "Ingestion failed" }
        ]),
        completed_at: db.fn.now()
      });
    return {
      ingestionId,
      status: "failed",
      stats,
      errors: [...errors, { line: 0, error: e instanceof Error ? e.message : "Ingestion failed" }]
    };
  }

  await db("kb_ingestions").where({ id: ingestionId }).update({
    status: "succeeded",
    stats_json: JSON.stringify(stats),
    errors_json: JSON.stringify(errors),
    completed_at: db.fn.now()
  });

  return { ingestionId, status: "succeeded", stats, errors };
}

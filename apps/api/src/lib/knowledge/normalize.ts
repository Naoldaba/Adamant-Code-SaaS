import crypto from "node:crypto";
import { z } from "zod";

// Mirrored from packages/db/src/types.ts (the API mirrors row types ad hoc; there
// is no build/exports path from @ac/db into the API).
export type KnowledgeItemType =
  | "docs"
  | "policies"
  | "api_reference"
  | "changelog"
  | "incidents"
  | "support"
  | "feature_flags"
  | "analytics_events"
  | "playbooks";

export type KbSourceType = KnowledgeItemType | "upload";

export const KNOWLEDGE_TYPES = [
  "docs",
  "policies",
  "api_reference",
  "changelog",
  "incidents",
  "support",
  "feature_flags",
  "analytics_events",
  "playbooks"
] as const;

/**
 * Schema for one line of an exported `knowledge_items` JSONL bundle (see
 * routes/exports.ts — each line is `JSON.stringify(row)`). Optional fields have
 * safe defaults so slightly older/newer exports still ingest, while a line that
 * is missing an `id`, `type`, or `title`, or carries an unknown `type`, is
 * rejected and reported per-line rather than silently dropped.
 */
export const exportRowSchema = z.object({
  id: z.string().min(1),
  type: z.enum(KNOWLEDGE_TYPES),
  title: z.string().min(1),
  category: z.string().optional().default(""),
  body: z.string().optional().default(""),
  metadata_json: z.record(z.unknown()).optional().default({}),
  tags: z.array(z.string()).optional().default([]),
  owner_id: z.string().nullable().optional(),
  created_at: z.union([z.string(), z.number(), z.date()]).optional(),
  updated_at: z.union([z.string(), z.number(), z.date()]).optional()
});

export type ExportRow = z.infer<typeof exportRowSchema>;

export type NormalizedDocument = {
  sourceType: KbSourceType;
  sourceId: string | null;
  title: string;
  content: string;
  metadataJson: Record<string, unknown>;
  contentHash: string;
};

/**
 * Turn nested `metadata_json` into readable, searchable text. Several module
 * types keep their substance in nested metadata (support `messages`, incident
 * `timeline`/`root_cause`, playbook `steps`, analytics `properties`, api
 * `method`/`path`), so a generic recursive walk flattens keys and array items
 * into "key: value" lines. This keeps the retrievable meaning of an item while
 * the raw structure is preserved separately for display and citation.
 */
export function metadataToText(value: unknown, keyPrefix = ""): string[] {
  const lines: string[] = [];

  if (value === null || value === undefined) return lines;

  if (Array.isArray(value)) {
    for (const item of value) {
      lines.push(...metadataToText(item, keyPrefix));
    }
    return lines;
  }

  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const label = keyPrefix ? `${keyPrefix}.${k}` : k;
      if (v === null || v === undefined) continue;
      if (typeof v === "object") {
        lines.push(...metadataToText(v, label));
      } else {
        lines.push(`${humanizeKey(label)}: ${String(v)}`);
      }
    }
    return lines;
  }

  const text = String(value).trim();
  if (text) lines.push(keyPrefix ? `${humanizeKey(keyPrefix)}: ${text}` : text);
  return lines;
}

function humanizeKey(key: string): string {
  return key
    .split(".")
    .map((part) => part.replace(/_/g, " "))
    .join(" › ");
}

/**
 * Build the normalized, chunk-ready representation of an exported row: the title,
 * body, and flattened metadata are concatenated into `content`; the original
 * provenance (module type, source id, category, tags, timestamps, filename) is
 * retained in `metadataJson` for traceability and citations; and a sha256 of the
 * normalized content is the dedup key.
 */
export function normalizeExportRow(row: ExportRow, extraMetadata: Record<string, unknown> = {}): NormalizedDocument {
  const metadataText = metadataToText(row.metadata_json);
  const contentParts = [row.title.trim(), (row.body ?? "").trim(), metadataText.join("\n").trim()].filter(
    (p) => p.length > 0
  );
  const content = contentParts.join("\n\n");

  const metadataJson: Record<string, unknown> = {
    filename: extraMetadata.filename ?? null,
    module_type: row.type,
    source_id: row.id,
    category: row.category ?? "",
    tags: row.tags ?? [],
    original_created_at: row.created_at ?? null,
    original_updated_at: row.updated_at ?? null,
    original_metadata: row.metadata_json ?? {},
    ...extraMetadata
  };

  return {
    sourceType: row.type as KnowledgeItemType,
    sourceId: row.id,
    title: row.title,
    content,
    metadataJson,
    contentHash: sha256(`${row.type}:${row.id}:${content}`)
  };
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

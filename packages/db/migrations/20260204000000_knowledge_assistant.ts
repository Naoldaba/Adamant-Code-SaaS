import type { Knex } from "knex";

// Embedding dimension is fixed per deployment. Default is 768 to match the value
// set in docker-compose.yml (the Gemini `gemini-embedding-001` output dim), so a
// migrate run outside Docker produces the same column type; the deterministic
// local provider and OpenAI (via its `dimensions` param) also emit this dimension,
// so the column type is stable regardless of provider.
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 768);

export async function up(knex: Knex): Promise<void> {
  if (!Number.isInteger(EMBEDDING_DIM) || EMBEDDING_DIM <= 0) {
    throw new Error(`EMBEDDING_DIM must be a positive integer (got: ${process.env.EMBEDDING_DIM})`);
  }

  // pgvector powers cosine similarity search over chunk embeddings.
  await knex.raw("create extension if not exists vector");

  // ------------------------------------------------------------------
  // kb_ingestions — one row per upload/ingest run (lifecycle + reporting).
  // Created before kb_documents so documents can reference their run.
  // ------------------------------------------------------------------
  await knex.schema.createTable("kb_ingestions", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("filename").nullable();
    t.text("source").notNullable(); // 'upload' | 'module'
    t.text("status").notNullable().defaultTo("pending"); // 'pending' | 'running' | 'succeeded' | 'failed'
    t.uuid("uploaded_by").nullable().references("id").inTable("users").onDelete("set null"); // from req.user.id
    t.jsonb("stats_json").notNullable().defaultTo("{}"); // { total, inserted, updated, skipped, failed }
    t.jsonb("errors_json").notNullable().defaultTo("[]"); // [{ line, error }]
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("completed_at", { useTz: true }).nullable();

    t.index(["status"]);
    t.index(["created_at"]);
    t.index(["uploaded_by"]);
  });

  // ------------------------------------------------------------------
  // kb_documents — one logical source document per ingested JSONL line
  // (or per uploaded free-form doc). The shared/global knowledge base.
  // ------------------------------------------------------------------
  await knex.schema.createTable("kb_documents", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("source_type").notNullable(); // module type (docs..playbooks) or 'upload'
    t.text("source_id").nullable(); // original knowledge_items.id — the citation -> module link
    t.text("title").notNullable();
    t.text("content").notNullable(); // normalized text used for chunking (body + flattened metadata)
    t.jsonb("metadata_json").notNullable().defaultTo("{}"); // filename, original row, category, tags, timestamps
    t.text("content_hash").notNullable(); // sha256 of normalized content — dedup
    t.uuid("ingestion_id").nullable().references("id").inTable("kb_ingestions").onDelete("set null");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Natural dedup key for module exports (source_id is the original PK).
    // Partial unique index so multiple uploads with NULL source_id are allowed.
    t.index(["source_type"]);
    t.index(["content_hash"]);
  });

  await knex.raw(
    `create unique index kb_documents_source_type_source_id_uniq
       on kb_documents (source_type, source_id)
       where source_id is not null`
  );

  // ------------------------------------------------------------------
  // kb_chunks — embeddable segments of a document.
  // ------------------------------------------------------------------
  await knex.schema.createTable("kb_chunks", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("document_id").notNullable().references("id").inTable("kb_documents").onDelete("cascade");
    t.integer("chunk_index").notNullable(); // order within document
    t.text("content").notNullable(); // chunk text
    t.integer("token_count").nullable();
    t.jsonb("metadata_json").notNullable().defaultTo("{}"); // offsets/headings
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(["document_id"]);
    t.unique(["document_id", "chunk_index"]);
  });

  // vector column + cosine ANN index (added via raw since Knex has no vector type).
  await knex.raw(`alter table kb_chunks add column embedding vector(${EMBEDDING_DIM})`);
  await knex.raw(
    `create index kb_chunks_embedding_cosine_idx
       on kb_chunks using hnsw (embedding vector_cosine_ops)`
  );

  // ------------------------------------------------------------------
  // conversations — per user.
  // ------------------------------------------------------------------
  await knex.schema.createTable("conversations", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("user_id").notNullable().references("id").inTable("users").onDelete("cascade"); // ownership
    t.text("title").notNullable().defaultTo("New conversation"); // auto-generated on first message; renameable
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(["user_id", "updated_at"]);
  });

  // ------------------------------------------------------------------
  // messages — chronological turns within a conversation.
  // ------------------------------------------------------------------
  await knex.schema.createTable("messages", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("conversation_id").notNullable().references("id").inTable("conversations").onDelete("cascade");
    t.text("role").notNullable(); // 'user' | 'assistant'
    t.text("content").notNullable();
    t.text("status").notNullable().defaultTo("complete"); // 'complete' | 'error' (never store a partial answer as complete)
    t.jsonb("error_json").nullable(); // provider failure detail
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(["conversation_id", "created_at"]);
  });

  // ------------------------------------------------------------------
  // message_citations — sources backing an assistant message.
  // source_type/source_id/title are snapshots so the citation survives
  // document re-ingestion or deletion.
  // ------------------------------------------------------------------
  await knex.schema.createTable("message_citations", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("message_id").notNullable().references("id").inTable("messages").onDelete("cascade");
    t.uuid("document_id").nullable().references("id").inTable("kb_documents").onDelete("set null");
    t.uuid("chunk_id").nullable().references("id").inTable("kb_chunks").onDelete("set null");
    t.text("source_type").notNullable(); // snapshot
    t.text("source_id").nullable(); // snapshot -> deep-link to the module item
    t.text("title").notNullable(); // snapshot
    t.specificType("score", "double precision").notNullable(); // similarity
    t.text("snippet").nullable(); // quoted evidence
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(["message_id"]);
    t.index(["document_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("message_citations");
  await knex.schema.dropTableIfExists("messages");
  await knex.schema.dropTableIfExists("conversations");
  await knex.schema.dropTableIfExists("kb_chunks");
  await knex.schema.dropTableIfExists("kb_documents");
  await knex.schema.dropTableIfExists("kb_ingestions");
  // Leave the `vector` extension in place; other objects may depend on it and
  // dropping an extension is not the migration's concern.
}

export type UserRole = "admin" | "member";

export type UserRow = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password_hash: string;
  created_at: Date;
};

export type SessionRow = {
  id: string;
  user_id: string;
  expires_at: Date;
  created_at: Date;
};

export type ProjectStatus = "active" | "paused" | "archived";

export type ProjectRow = {
  id: string;
  name: string;
  status: ProjectStatus;
  created_at: Date;
};

export type EntityStatus = "open" | "closed" | "pending";

export type EntityRow = {
  id: string;
  name: string;
  email_or_key: string;
  status: EntityStatus;
  created_at: Date;
};

export type ActivityLogRow = {
  id: string;
  actor_user_id: string | null;
  action: string;
  metadata_json: unknown;
  created_at: Date;
};

export type FeatureFlagRow = {
  id: string;
  key: string;
  enabled: boolean;
};

export type ApiKeyRow = {
  id: string;
  name: string;
  last4: string;
  created_at: Date;
};

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

export type KnowledgeItemRow = {
  id: string;
  type: KnowledgeItemType;
  title: string;
  category: string;
  body: string;
  metadata_json: Record<string, unknown>;
  tags: string[];
  owner_id: string | null;
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// Knowledge Assistant (RAG) rows
// ---------------------------------------------------------------------------

// A document's originating module type, or `upload` for admin file uploads.
export type KbSourceType = KnowledgeItemType | "upload";

export type IngestionSource = "upload" | "module";

export type IngestionStatus = "pending" | "running" | "succeeded" | "failed";

export type IngestionStats = {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
};

export type IngestionError = {
  line: number;
  error: string;
};

export type KbIngestionRow = {
  id: string;
  filename: string | null;
  source: IngestionSource;
  status: IngestionStatus;
  uploaded_by: string | null;
  stats_json: IngestionStats | Record<string, never>;
  errors_json: IngestionError[];
  created_at: Date;
  completed_at: Date | null;
};

export type KbDocumentRow = {
  id: string;
  source_type: KbSourceType;
  source_id: string | null;
  title: string;
  content: string;
  metadata_json: Record<string, unknown>;
  content_hash: string;
  ingestion_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type KbChunkRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  // Stored as a pgvector `vector` column; surfaced as a number[] in app code.
  embedding: number[] | null;
  metadata_json: Record<string, unknown>;
  created_at: Date;
};

export type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
};

export type MessageRole = "user" | "assistant";

export type MessageStatus = "complete" | "error";

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  error_json: Record<string, unknown> | null;
  created_at: Date;
};

export type MessageCitationRow = {
  id: string;
  message_id: string;
  document_id: string | null;
  chunk_id: string | null;
  source_type: KbSourceType;
  source_id: string | null;
  title: string;
  score: number;
  snippet: string | null;
  created_at: Date;
};

# Knowledge Assistant Acceptance Checklist

> Progress key: [x] done · [~] partial (phase in progress) · [ ] not started.
> Phase 2 (Ingestion + admin Uploader) is complete; RAG chatbot and conversation
> management are later phases.

## Access

- [x] Knowledge Assistant in sidebar
- [x] Authentication works (module lives under the `RequireAuth` dashboard layout)
- [x] Chatbot tab (placeholder pending the RAG phase)
- [x] Knowledge Uploader tab
- [x] Uploader is admin-only (UI gated by role + backend enforced)
- [x] Backend authorization enforced (`requireRole("admin")`; 401/403 covered by tests)

## Knowledge Base

- [x] Global/shared KB (`kb_documents`/`kb_chunks` are not user-scoped)
- [x] Existing JSONL exports can be ingested (file upload + ingest-from-module)
- [x] Supported format validation (`.jsonl`/`.ndjson` only)
- [x] Empty file rejected
- [x] Oversized file rejected (`KB_MAX_UPLOAD_MB`)
- [x] Malformed JSON handled safely (skip-and-report; the run still succeeds)
- [x] Line number/error reported (1-based line + parser/validation message)
- [x] Source metadata preserved (module type, source_id, category, tags, timestamps, filename)
- [x] Duplicate uploads handled (insert/update/skip by `(source_type, source_id)`)
- [x] Insert/update/skip/failure results available (in response + `kb_ingestions` history)
- [x] Content searchable only after successful ingestion (single transaction commits at end)

## RAG

- [x] Relevant questions answered (`POST /assistant/conversations/:id/messages`)
- [x] Answers grounded in KB (answer generated only from retrieved chunks; strict system prompt)
- [x] Citations returned (per assistant message, from the retrieved contexts)
- [x] Citations map to real sources (link to `kb_documents`/`kb_chunks`; snapshot `source_type`/`source_id` = original `knowledge_items.id`)
- [x] Insufficient knowledge handled (relevance threshold → explicit non-answer, no citations)
- [x] Provider failure handled (`502`; assistant turn stored as `error`, never `complete`)
- [x] Failed/partial answer not stored as successful (verified by integration test)

## Conversations

> The RAG phase added the endpoints the answer flow needs (create, open,
> continue, auto-name, isolation, citations). The conversations phase completes
> full lifecycle management: list, rename, delete.

- [x] Create (`POST /assistant/conversations`)
- [x] List (`GET /assistant/conversations` — own only, newest activity first, message counts)
- [x] Open (`GET /assistant/conversations/:id` — messages + citations)
- [x] Continue (post further messages to an existing conversation)
- [x] Rename (`PATCH /assistant/conversations/:id` — owner-scoped)
- [x] Delete (`DELETE /assistant/conversations/:id` — owner-scoped; cascades messages/citations)
- [x] Automatic name (title derived from the first question)
- [x] Chronological messages (ordered by `created_at`)
- [x] Per-user isolation (owner-only; foreign access → 404; verified by test)
- [x] Citations preserved (stored in `message_citations`, returned on open)

## Frontend

- [ ] Chat UI (placeholder only this phase)
- [ ] Conversation sidebar
- [x] Loading states (module page + uploader)
- [x] Error states (upload/module ingest failures surfaced)
- [x] Empty states (empty knowledge base message)
- [ ] Citation UI
- [x] Uploader UI (file picker, format/size hints, module ingest)
- [x] Ingestion results (per-file insert/update/skip/failure + per-line errors + history)

## Quality

- [x] Tests pass (42 hermetic unit tests + 20 DB-gated integration tests, all green)
- [x] Type check passes (`@ac/api` and `@ac/web`)
- [ ] Lint passes (pre-existing: the scaffold's `next lint` script is removed in Next 16; not introduced by this phase)
- [x] Migrations work (verified via `migrate:latest` on pgvector in integration setup and in `docker compose up`)
- [x] `docker compose up` works (full stack built & started; API/DB/web healthy; ingestion acceptance criteria exercised end-to-end via HTTP)
- [x] README updated (Knowledge Assistant endpoints, ingestion behavior, env vars, testing)
- [x] No secrets committed
- [~] Final diff reviewed (per-phase; full review in the final phase)

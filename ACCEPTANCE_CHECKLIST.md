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

- [ ] Relevant questions answered
- [ ] Answers grounded in KB
- [ ] Citations returned
- [ ] Citations map to real sources
- [ ] Insufficient knowledge handled
- [ ] Provider failure handled
- [ ] Failed/partial answer not stored as successful

## Conversations

- [ ] Create
- [ ] List
- [ ] Open
- [ ] Continue
- [ ] Rename
- [ ] Delete
- [ ] Automatic name
- [ ] Chronological messages
- [ ] Per-user isolation
- [ ] Citations preserved

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

- [x] Tests pass (35 hermetic unit tests + 8 DB-gated integration tests, all green)
- [x] Type check passes (`@ac/api` and `@ac/web`)
- [ ] Lint passes (pre-existing: the scaffold's `next lint` script is removed in Next 16; not introduced by this phase)
- [x] Migrations work (verified via `migrate:latest` on pgvector in integration setup and in `docker compose up`)
- [x] `docker compose up` works (full stack built & started; API/DB/web healthy; ingestion acceptance criteria exercised end-to-end via HTTP)
- [x] README updated (Knowledge Assistant endpoints, ingestion behavior, env vars, testing)
- [x] No secrets committed
- [~] Final diff reviewed (per-phase; full review in the final phase)

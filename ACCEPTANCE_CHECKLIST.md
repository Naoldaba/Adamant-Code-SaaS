# Knowledge Assistant Acceptance Checklist

## Access

- [ ] Knowledge Assistant in sidebar
- [ ] Authentication works
- [ ] Chatbot tab
- [ ] Knowledge Uploader tab
- [ ] Uploader is admin-only
- [ ] Backend authorization enforced

## Knowledge Base

- [ ] Global/shared KB
- [ ] Existing JSONL exports can be ingested
- [ ] Supported format validation
- [ ] Empty file rejected
- [ ] Oversized file rejected
- [ ] Malformed JSON handled safely
- [ ] Line number/error reported
- [ ] Source metadata preserved
- [ ] Duplicate uploads handled
- [ ] Insert/update/skip/failure results available
- [ ] Content searchable only after successful ingestion

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

- [ ] Chat UI
- [ ] Conversation sidebar
- [ ] Loading states
- [ ] Error states
- [ ] Empty states
- [ ] Citation UI
- [ ] Uploader UI
- [ ] Ingestion results

## Quality

- [ ] Tests pass
- [ ] Type check passes
- [ ] Lint passes
- [ ] Migrations work
- [ ] `docker compose up` works
- [ ] README updated
- [ ] No secrets committed
- [ ] Final diff reviewed
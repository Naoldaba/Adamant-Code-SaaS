# Adamant SaaS Dashboard

A knowledge base dashboard built with Next.js (App Router) + Express REST API + PostgreSQL (Knex migrations/seeds).

This repository contains realistic knowledge modules that can be exported as JSONL documents for building AI knowledge bases.

## Quick Start (Docker)

Prerequisites: Docker Desktop (or Docker Engine + Compose).

```bash
docker compose up --build
```

Then open:
- Web: `http://localhost:3000`
- API health: `http://localhost:4000/healthz`

Demo login:
- Email: `admin@ac.local`
- Password: `password`

### Stop / Reset

```bash
docker compose down
```

To wipe the database volume:

```bash
docker compose down -v
```

## Local Development (without Docker)

Prerequisites: Node.js 20.9+, npm, Postgres 16+.

1. Install dependencies:
```bash
npm ci
```

2. Set environment variables:
```bash
cp env.example .env
```

3. Run migrations and seed data:
```bash
npm run db:migrate
npm run db:seed
```

4. Start both apps:
```bash
npm run dev
```

## Knowledge Modules

The dashboard contains 9 knowledge modules, each with realistic seed data:

| Module | Description | Items |
|--------|-------------|-------|
| **Docs Library** | Product documentation, onboarding guides, how-tos, glossary | ~20 |
| **Policies & Compliance** | Privacy policy, data retention, security guidelines, SLAs | ~15 |
| **API Reference** | Endpoint definitions, auth methods, rate limits, examples | ~25 |
| **Changelog** | Version releases, breaking changes, migration notes | ~15 |
| **Incidents & Postmortems** | Incident timelines, impact, root cause, remediation | ~10 |
| **Support Conversations** | Anonymized support threads with resolutions | ~15 |
| **Feature Flags** | Flag configs, rollout percentages, target segments | ~15 |
| **Analytics Events** | Event schemas, when fired, sample payloads | ~15 |
| **Internal Playbooks** | On-call runbooks, deployment checklists, troubleshooting | ~12 |

## Database Schema

All knowledge is stored in a single `knowledge_items` table:

```sql
CREATE TABLE knowledge_items (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,          -- docs, policies, api_reference, etc.
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  body TEXT NOT NULL,          -- markdown content
  metadata_json JSONB,         -- structured data per type
  tags TEXT[],
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

-- Indexes for filtering
CREATE INDEX ON knowledge_items (type);
CREATE INDEX ON knowledge_items (category);
CREATE INDEX ON knowledge_items (updated_at);
CREATE INDEX ON knowledge_items (type, category);
```

## Exporting Data as JSONL

Each module can be exported as JSONL (JSON Lines) format for ingestion into AI systems.

### Via UI

1. Navigate to any module (e.g., `/dashboard/knowledge/docs`)
2. Click the "Export JSONL" button
3. File downloads automatically

### Via API

```bash
# Export all docs
curl -H "Cookie: ac_session=YOUR_SESSION" \
  http://localhost:4000/exports/docs

# Export with filters
curl -H "Cookie: ac_session=YOUR_SESSION" \
  "http://localhost:4000/exports/docs?category=getting-started"

# Export specific items
curl -H "Cookie: ac_session=YOUR_SESSION" \
  "http://localhost:4000/exports/docs?ids=uuid1,uuid2"

# Export items updated after a date
curl -H "Cookie: ac_session=YOUR_SESSION" \
  "http://localhost:4000/exports/docs?updated_after=2026-01-01"
```

### JSONL Format

Each line is a complete JSON object:

```jsonl
{"id":"abc123","type":"docs","title":"Getting Started","category":"getting-started","body":"# Welcome...","tags":["onboarding"],"metadata_json":{"reading_time_minutes":5},"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-15T00:00:00.000Z"}
{"id":"def456","type":"docs","title":"API Quickstart","category":"getting-started","body":"# API Guide...","tags":["api"],"metadata_json":{"reading_time_minutes":8},"created_at":"2026-01-02T00:00:00.000Z","updated_at":"2026-01-16T00:00:00.000Z"}
```

## API Endpoints

### Knowledge Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/knowledge/:type` | List items with pagination and filters |
| GET | `/knowledge/:type/:id` | Get single item |
| GET | `/knowledge/stats/counts` | Get item counts per type |
| GET | `/knowledge/recent/all` | Get recent items across all types |

### Export Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/exports/:type` | Export items as JSONL |

Query parameters for exports:
- `ids` - Comma-separated UUIDs to export specific items
- `category` - Filter by category
- `updated_after` - ISO date string for incremental exports

Valid types: `docs`, `policies`, `api_reference`, `changelog`, `incidents`, `support`, `feature_flags`, `analytics_events`, `playbooks`

### Knowledge Assistant Endpoints

The Knowledge Assistant module (sidebar → **Knowledge Assistant**) has two tabs: a
**Chatbot** (RAG) and an admin-only **Knowledge Uploader** that ingests JSONL/NDJSON
exports into a single shared/global knowledge base.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/assistant/knowledge/ingest?filename=<name.jsonl>` | admin | Ingest an uploaded JSONL/NDJSON file (raw text body) |
| POST | `/assistant/knowledge/ingest/from-module/:type` | admin | Ingest an existing module directly from the DB |
| GET | `/assistant/knowledge/ingestions` | admin | Ingestion run history (counts + per-line errors) |
| GET | `/assistant/knowledge/documents` | authenticated | Ingested knowledge base summary (counts + totals) |
| POST | `/assistant/conversations` | authenticated | Create a conversation (owned by the current user) |
| GET | `/assistant/conversations/:id` | owner | Open a conversation: messages (chronological) + citations |
| POST | `/assistant/conversations/:id/messages` | owner | Ask a question (RAG); returns the grounded answer + citations |
| POST | `/assistant/conversations/:id/messages/stream` | owner | Ask a question (RAG); streams the answer incrementally over SSE |

**Ingestion behavior**

- **Format/size validation** — only `.jsonl`/`.ndjson` are accepted; empty files and
  files larger than `KB_MAX_UPLOAD_MB` (default 5 MB) are rejected with a clear message.
- **Safe parsing** — each line is parsed independently; malformed lines are skipped and
  reported with their 1-based line number and error message (the rest still ingest).
- **Source metadata preserved** — each ingested document retains its origin
  (`module_type`, `source_id` = original `knowledge_items.id`, category, tags,
  timestamps, filename) for traceability and future citations.
- **Deduplication** — documents are keyed by `(source_type, source_id)`; re-ingesting the
  same item **updates** it (or **skips** if unchanged) rather than creating duplicates.
  The response reports `inserted` / `updated` / `skipped` / `failed` counts.
- **Searchable only after success** — all document/chunk writes happen in one transaction,
  so content becomes visible to retrieval only after the ingestion run succeeds; a failed
  run rolls back and contributes nothing.

The upload file is sent as the raw request body with `Content-Type: text/plain` (the
filename travels as the `filename` query parameter), so no multipart dependency is required.

**Embeddings / provider** — chunk embeddings are produced by a pluggable provider. A
deterministic, offline **local** provider (feature-hashed, L2-normalized vectors of
`EMBEDDING_DIM` dimensions) is used by default so ingestion and chat work with no API key.
When `OPENAI_API_KEY` or `GEMINI_API_KEY` is set, that hosted provider is used for both
embeddings and generation instead (priority OpenAI → Gemini → local). Embeddings are stored
in a pgvector `vector(EMBEDDING_DIM)` column and searched by cosine similarity.

> **Note on the keyless default:** without an `OPENAI_API_KEY`, the local answer
> provider is *extractive* — it returns the relevant retrieved chunks verbatim with
> `[n]` markers rather than a synthesized natural-language answer. This keeps the
> assistant fully grounded and reproducible with no external dependency (which is what
> `docker compose up` and the tests rely on). Set `OPENAI_API_KEY` to get synthesized
> answers; the retrieval, citation, insufficient-knowledge, and provider-failure
> behavior is identical either way.

**RAG chat behavior**

- **Grounded answers** — a question is embedded and matched against stored chunks by cosine
  similarity; only chunks clearing `RAG_MIN_SCORE` (relevance filtering) are used. The answer
  is generated strictly from those retrieved chunks — the assistant does not fabricate.
- **Citations** — every grounded answer stores `message_citations` that snapshot the source
  (`source_type`, `source_id` = original `knowledge_items.id`, title, score, snippet) and link
  to the real `kb_documents`/`kb_chunks`, so each citation maps back to its originating module
  item even after re-ingestion.
- **Insufficient knowledge** — if nothing clears the relevance threshold, the assistant returns
  an explicit "not in the knowledge base — try ingesting the source material" response with **no
  citations**, rather than guessing.
- **Provider failure** — if the answer provider fails or times out, the endpoint returns `502`
  and the assistant turn is recorded with `status = "error"` (never `complete`); a failed or
  partial answer is never stored or returned as successful.
- **Conversations** — belong to the authenticated user (ownership enforced on every endpoint via
  the session, never a client-supplied id); the title is auto-generated from the first question.
- **Streaming (SSE)** — the chatbot uses `POST /assistant/conversations/:id/messages/stream`, which
  returns `text/event-stream` and pushes the answer as it is generated. The pre-generation pipeline
  is identical to the non-streaming endpoint (retrieval + grounding threshold run **first**); a token
  stream starts only after the guardrails pass. Events, in order: `user` (persisted user turn) → then
  either `insufficient` (the no-knowledge answer, emitted with **no** token stream) or `delta`* +
  `done` (the completed message + citations). `error` replaces `done` on provider failure. Only the
  fully-accumulated answer is persisted, and only on success — a partial answer is **never** stored as
  complete, including when the client disconnects mid-stream (the server aborts generation and stores
  nothing for that turn). The local provider streams too, so incremental output works with no API key.
  The non-streaming `POST .../messages` endpoint remains available and behaves as before.

## Project Structure

```
├── apps/
│   ├── api/              # Express REST API
│   │   └── src/
│   │       ├── routes/   # API routes
│   │       │   ├── knowledge.ts
│   │       │   └── exports.ts
│   │       └── server.ts
│   └── web/              # Next.js dashboard
│       ├── app/
│       │   └── (dashboard)/dashboard/knowledge/
│       │       ├── docs/
│       │       ├── policies/
│       │       ├── api-reference/
│       │       ├── changelog/
│       │       ├── incidents/
│       │       ├── support/
│       │       ├── feature-flags/
│       │       ├── analytics-events/
│       │       └── playbooks/
│       └── components/
├── packages/
│   └── db/               # Database migrations and seeds
│       ├── migrations/
│       │   ├── 20260128120000_init.ts
│       │   └── 20260202000000_knowledge_modules.ts
│       └── seeds/
│           ├── 01_seed_core.ts
│           └── 02_seed_knowledge.ts
└── docker-compose.yml
```

## Testing

Run API tests:

```bash
cd apps/api
npm test
```

The default test run is hermetic (no database required) and covers JSONL parsing,
upload validation, metadata flattening, chunking, deduplication decisions, and the
local embedding provider.

Additional HTTP-level integration tests run against a real pgvector Postgres when
`DATABASE_URL_TEST` is set; otherwise they are skipped. They cover auth enforcement, the
full ingestion lifecycle, deduplication counts, searchable-after-success, and the RAG chat
path (grounded answer + citations mapping to real sources, insufficient knowledge, provider
failure not stored as successful, and per-user conversation isolation):

```bash
# start a throwaway pgvector database, then:
DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/ac_test npm --workspace @ac/api test
```

> **Lint:** `@ac/web`'s `lint` script still calls `next lint`, which Next 16 removed,
> so `npm run lint` errors out. This is a pre-existing scaffold/tooling issue unrelated
> to the Knowledge Assistant feature; typecheck (`npm run typecheck`) and the test
> suites are the quality gates used here.

## Environment Variables

See `env.example` for the full list. Knowledge Assistant additions:

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_DIM` | `768` | Embedding vector dimension (must match the migration column and provider; 768 = Gemini `text-embedding-004`, also valid for local/OpenAI) |
| `KB_MAX_UPLOAD_MB` | `5` | Maximum Knowledge Uploader file size in MB |
| `RAG_TOP_K` | `6` | Number of chunks retrieved per question before relevance filtering |
| `RAG_MIN_SCORE` | `0.1` | Minimum cosine similarity for a chunk to be considered relevant (tuned for the offline local provider, whose scores are low/compressed; raise it when using a real embedding provider) |
| `OPENAI_API_KEY` | _(unset)_ | Optional; when set, OpenAI is used for embeddings + answer generation instead of the local provider |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Chat model used when `OPENAI_API_KEY` is set |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model used when `OPENAI_API_KEY` is set |
| `GEMINI_API_KEY` | _(unset)_ | Optional (has a free tier); when set (and no `OPENAI_API_KEY`), Google Gemini is used for embeddings + answer generation |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Gemini chat model used when `GEMINI_API_KEY` is set (transient 503/429 are retried) |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` | Gemini embedding model used when `GEMINI_API_KEY` is set (requested at 768-dim) |

Provider priority is **OpenAI → Gemini → offline local**. Set exactly one key. Because
stored chunk vectors and query vectors must come from the same model (and match
`EMBEDDING_DIM`), switching providers or changing the dimension requires a fresh DB
(`docker compose down -v`) and re-ingestion.

## License

ISC

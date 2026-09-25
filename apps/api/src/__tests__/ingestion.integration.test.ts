import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import knexLib, { type Knex } from "knex";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";

/**
 * HTTP-level ingestion tests against a real Postgres (pgvector) test database.
 *
 * These are gated on DATABASE_URL_TEST so the default `npm test` stays fast and
 * hermetic (no DB required). Point DATABASE_URL_TEST at a pgvector-enabled
 * Postgres to run them, e.g.:
 *   DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/ac_test npm test
 */
const TEST_DB = process.env.DATABASE_URL_TEST;
const suite = TEST_DB ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../../../packages/db/migrations");

function exportLine(o: Record<string, unknown>): string {
  return JSON.stringify({
    id: o.id,
    type: o.type ?? "docs",
    title: o.title ?? "Untitled",
    category: o.category ?? "general",
    body: o.body ?? "",
    metadata_json: o.metadata_json ?? {},
    tags: o.tags ?? [],
    owner_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-15T00:00:00.000Z"
  });
}

suite("Ingestion HTTP integration", () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;

  async function createUserWithSession(role: "admin" | "member"): Promise<string> {
    const userId = crypto.randomUUID();
    await db("users").insert({
      id: userId,
      email: `${role}-${userId}@test.local`,
      name: `${role} user`,
      role,
      password_hash: "x"
    });
    const sessionId = crypto.randomUUID();
    await db("sessions").insert({
      id: sessionId,
      user_id: userId,
      expires_at: new Date(Date.now() + 86_400_000)
    });
    return `ac_session=${sessionId}`;
  }

  beforeAll(async () => {
    db = knexLib({
      client: "pg",
      connection: TEST_DB,
      migrations: { directory: migrationsDir }
    });
    await db.migrate.latest();
    app = createApp(db);
    adminCookie = await createUserWithSession("admin");
    memberCookie = await createUserWithSession("member");
  }, 60_000);

  afterAll(async () => {
    if (db) await db.destroy();
  });

  it("rejects unauthenticated ingest with 401", async () => {
    const res = await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.jsonl")
      .set("content-type", "text/plain")
      .send(exportLine({ id: crypto.randomUUID() }));
    expect(res.status).toBe(401);
  });

  it("rejects non-admin ingest with 403 (backend authorization)", async () => {
    const res = await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.jsonl")
      .set("Cookie", memberCookie)
      .set("content-type", "text/plain")
      .send(exportLine({ id: crypto.randomUUID() }));
    expect(res.status).toBe(403);
  });

  it("rejects an empty file with a clear validation message", async () => {
    const res = await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.jsonl")
      .set("Cookie", adminCookie)
      .set("content-type", "text/plain")
      .send("   ");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/empty/i);
  });

  it("rejects an unsupported format", async () => {
    const res = await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.csv")
      .set("Cookie", adminCookie)
      .set("content-type", "text/plain")
      .send("a,b,c");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Unsupported file format/i);
  });

  it("ingests valid lines, reports malformed lines, and makes content searchable only after success", async () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    const body = [
      exportLine({ id: id1, title: "Password reset", body: "Use the SSO recovery flow." }),
      "{ not valid json",
      exportLine({ id: id2, title: "Billing FAQ", body: "Charges occur monthly." })
    ].join("\n");

    const before = await request(app).get("/assistant/knowledge/documents").set("Cookie", adminCookie);
    const beforeTotal = before.body.data.totalDocuments as number;

    const res = await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.jsonl")
      .set("Cookie", adminCookie)
      .set("content-type", "text/plain")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.ingestion.status).toBe("succeeded");
    expect(res.body.data.ingestion.stats.inserted).toBe(2);
    expect(res.body.data.ingestion.stats.failed).toBe(1);
    expect(res.body.data.ingestion.errors[0].line).toBe(2);

    const after = await request(app).get("/assistant/knowledge/documents").set("Cookie", adminCookie);
    expect((after.body.data.totalDocuments as number)).toBe(beforeTotal + 2);
    expect((after.body.data.totalChunks as number)).toBeGreaterThanOrEqual(2);
  });

  it("skips unchanged re-uploads (no uncontrolled duplication)", async () => {
    const id = crypto.randomUUID();
    const line = exportLine({ id, title: "Stable doc", body: "unchanged content" });

    const first = await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.jsonl")
      .set("Cookie", adminCookie)
      .set("content-type", "text/plain")
      .send(line);
    expect(first.body.data.ingestion.stats.inserted).toBe(1);

    const second = await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.jsonl")
      .set("Cookie", adminCookie)
      .set("content-type", "text/plain")
      .send(line);
    expect(second.body.data.ingestion.stats.skipped).toBe(1);
    expect(second.body.data.ingestion.stats.inserted).toBe(0);
  });

  it("updates a document when its content changes", async () => {
    const id = crypto.randomUUID();
    await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.jsonl")
      .set("Cookie", adminCookie)
      .set("content-type", "text/plain")
      .send(exportLine({ id, title: "Doc", body: "version one" }));

    const updated = await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.jsonl")
      .set("Cookie", adminCookie)
      .set("content-type", "text/plain")
      .send(exportLine({ id, title: "Doc", body: "version two changed" }));

    expect(updated.body.data.ingestion.stats.updated).toBe(1);

    const doc = await db("kb_documents").where({ source_type: "docs", source_id: id }).first();
    expect(doc.content).toContain("version two changed");
  });

  it("records an ingestion run in history for admins", async () => {
    const res = await request(app).get("/assistant/knowledge/ingestions").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });
});

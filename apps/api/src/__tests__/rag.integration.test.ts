import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { type Knex } from "knex";
import crypto from "node:crypto";
import { createApp } from "../app.js";
import { createAnswer } from "../lib/knowledge/rag.js";
import { ProviderError, type ChatProvider } from "../lib/knowledge/provider.js";
import { connectAndMigrate } from "./helpers/testDb.js";

/**
 * HTTP + service-level RAG tests against a real Postgres (pgvector) test database.
 * Gated on DATABASE_URL_TEST so the default `npm test` stays hermetic:
 *   DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/ac_test npm test
 */
const TEST_DB = process.env.DATABASE_URL_TEST;
const suite = TEST_DB ? describe : describe.skip;

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

suite("RAG chat integration", () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let adminId: string;
  let otherId: string;
  let otherCookie: string;
  // A distinctive source id + topic so retrieval and citations are deterministic
  // even though this suite shares the test database with the ingestion suite.
  const widgetDocId = `rag-widget-${crypto.randomUUID()}`;
  const WIDGET_QUESTION = "How do I pair a Zephyrix widget?";

  async function createUserWithSession(role: "admin" | "member"): Promise<{ id: string; cookie: string }> {
    const userId = crypto.randomUUID();
    await db("users").insert({
      id: userId,
      email: `${role}-${userId}@test.local`,
      name: `${role} user`,
      role,
      password_hash: "x"
    });
    const sessionId = crypto.randomUUID();
    await db("sessions").insert({ id: sessionId, user_id: userId, expires_at: new Date(Date.now() + 86_400_000) });
    return { id: userId, cookie: `ac_session=${sessionId}` };
  }

  async function newConversation(cookie: string): Promise<string> {
    const res = await request(app).post("/assistant/conversations").set("Cookie", cookie).send({});
    expect(res.status).toBe(201);
    return res.body.data.conversation.id as string;
  }

  beforeAll(async () => {
    db = await connectAndMigrate(TEST_DB!);
    app = createApp(db);
    const admin = await createUserWithSession("admin");
    adminId = admin.id;
    adminCookie = admin.cookie;
    const other = await createUserWithSession("member");
    otherId = other.id;
    otherCookie = other.cookie;

    // Ingest a document on a distinctive topic the chatbot can ground against.
    const ingest = await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.jsonl")
      .set("Cookie", adminCookie)
      .set("content-type", "text/plain")
      .send(
        exportLine({
          id: widgetDocId,
          title: "Zephyrix widget pairing",
          body: "To pair a Zephyrix widget, open Settings and enter the pairing code printed on the device label."
        })
      );
    expect(ingest.body.data.ingestion.status).toBe("succeeded");
  }, 60_000);

  afterAll(async () => {
    if (db) await db.destroy();
  });

  it("answers a relevant question and returns citations that map to a real stored document", async () => {
    const conversationId = await newConversation(adminCookie);
    const res = await request(app)
      .post(`/assistant/conversations/${conversationId}/messages`)
      .set("Cookie", adminCookie)
      .send({ content: WIDGET_QUESTION });

    expect(res.status).toBe(201);
    expect(res.body.data.insufficient).toBe(false);
    expect(res.body.data.message.status).toBe("complete");
    expect(res.body.data.message.content.length).toBeGreaterThan(0);

    const citations = res.body.data.citations as Array<Record<string, unknown>>;
    expect(citations.length).toBeGreaterThan(0);
    const cite = citations[0];
    expect(cite.sourceType).toBe("docs");
    expect(cite.sourceId).toBe(widgetDocId);

    // Citation maps to a real stored document/chunk.
    const doc = await db("kb_documents").where({ id: cite.documentId as string }).first();
    expect(doc).toBeTruthy();
    expect(doc.source_id).toBe(widgetDocId);
    const chunk = await db("kb_chunks").where({ id: cite.chunkId as string }).first();
    expect(chunk).toBeTruthy();
  });

  it("auto-names the conversation from the first question and persists messages chronologically", async () => {
    const conversationId = await newConversation(adminCookie);
    await request(app)
      .post(`/assistant/conversations/${conversationId}/messages`)
      .set("Cookie", adminCookie)
      .send({ content: WIDGET_QUESTION });

    const opened = await request(app).get(`/assistant/conversations/${conversationId}`).set("Cookie", adminCookie);
    expect(opened.status).toBe(200);
    expect(opened.body.data.conversation.title).toMatch(/pair a zephyrix widget/i);
    const messages = opened.body.data.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const assistant = messages[1];
    expect((assistant.citations as unknown[]).length).toBeGreaterThan(0);
  });

  it("returns an explicit insufficient-knowledge answer with no citations when nothing is relevant", async () => {
    const conversationId = await newConversation(adminCookie);
    const res = await request(app)
      .post(`/assistant/conversations/${conversationId}/messages`)
      .set("Cookie", adminCookie)
      .send({ content: "Explain lattice quantum chromodynamics renormalization schemes." });

    expect(res.status).toBe(201);
    expect(res.body.data.insufficient).toBe(true);
    expect(res.body.data.citations).toHaveLength(0);
    expect(res.body.data.message.content.toLowerCase()).toContain("knowledge base");

    // No fabricated citations were stored.
    const stored = await db("message_citations").where({ message_id: res.body.data.message.id });
    expect(stored).toHaveLength(0);
  });

  it("on provider failure returns an error and never stores a partial answer as successful", async () => {
    const conversationId = await newConversation(adminCookie);
    const failing: ChatProvider = {
      name: "failing",
      async generateAnswer() {
        throw new ProviderError("simulated upstream timeout");
      }
    };

    await expect(
      createAnswer(db, {
        conversationId,
        userId: adminId,
        question: WIDGET_QUESTION,
        chatProvider: failing
      })
    ).rejects.toBeInstanceOf(ProviderError);

    // The user turn is kept; no assistant turn is stored as complete.
    const messages = await db("messages").where({ conversation_id: conversationId }).orderBy("created_at", "asc");
    const assistant = messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].status).toBe("error");
    expect(assistant.some((m) => m.status === "complete")).toBe(false);
    const citations = await db("message_citations").whereIn(
      "message_id",
      messages.map((m) => m.id)
    );
    expect(citations).toHaveLength(0);
  });

  it("enforces per-user conversation isolation (owner-only)", async () => {
    const conversationId = await newConversation(adminCookie);

    const foreignRead = await request(app)
      .get(`/assistant/conversations/${conversationId}`)
      .set("Cookie", otherCookie);
    expect(foreignRead.status).toBe(404);

    const foreignAsk = await request(app)
      .post(`/assistant/conversations/${conversationId}/messages`)
      .set("Cookie", otherCookie)
      .send({ content: WIDGET_QUESTION });
    expect(foreignAsk.status).toBe(404);

    // The service layer rejects a foreign user id directly too.
    const svc = await createAnswer(db, {
      conversationId,
      userId: otherId,
      question: WIDGET_QUESTION
    });
    expect(svc).toBeNull();
  });

  it("requires authentication to ask", async () => {
    const conversationId = await newConversation(adminCookie);
    const res = await request(app)
      .post(`/assistant/conversations/${conversationId}/messages`)
      .send({ content: WIDGET_QUESTION });
    expect(res.status).toBe(401);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { type Knex } from "knex";
import crypto from "node:crypto";
import { createApp } from "../app.js";
import { streamAnswer } from "../lib/knowledge/rag.js";
import { ProviderError, type ChatProvider } from "../lib/knowledge/provider.js";
import { connectAndMigrate } from "./helpers/testDb.js";

/**
 * HTTP + service-level tests for the streaming (SSE) RAG endpoint against a real
 * Postgres (pgvector) test database. Gated on DATABASE_URL_TEST so the default
 * `npm test` stays hermetic:
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

type SseFrame = { event: string; data: Record<string, unknown> };

/** Parse a buffered text/event-stream body into its ordered frames. */
function parseSse(text: string): SseFrame[] {
  return text
    .split("\n\n")
    .filter((f) => f.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "";
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

suite("RAG streaming (SSE) integration", () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let adminId: string;
  let otherCookie: string;
  const widgetDocId = `stream-widget-${crypto.randomUUID()}`;
  const WIDGET_QUESTION = "How do I pair a Quokka widget?";

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
    otherCookie = other.cookie;

    await db("kb_documents").where("source_id", "like", "stream-widget-%").del();
    const ingest = await request(app)
      .post("/assistant/knowledge/ingest?filename=docs.jsonl")
      .set("Cookie", adminCookie)
      .set("content-type", "text/plain")
      .send(
        exportLine({
          id: widgetDocId,
          title: "Quokka widget pairing",
          body: "To pair a Quokka widget, open Settings and enter the pairing code printed on the device label."
        })
      );
    expect(ingest.body.data.ingestion.status).toBe("succeeded");
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db("kb_documents").where("source_id", "like", "stream-widget-%").del();
      await db.destroy();
    }
  });

  it("streams a grounded answer as delta events and finalizes with citations, persisting only the complete answer", async () => {
    const conversationId = await newConversation(adminCookie);
    const res = await request(app)
      .post(`/assistant/conversations/${conversationId}/messages/stream`)
      .set("Cookie", adminCookie)
      .send({ content: WIDGET_QUESTION });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const frames = parseSse(res.text);
    const types = frames.map((f) => f.event);
    expect(types[0]).toBe("user"); // user turn confirmed first
    expect(types).toContain("delta"); // actually streamed
    expect(types[types.length - 1]).toBe("done"); // finalized last
    expect(types).not.toContain("error");

    // The concatenated deltas equal the finalized message content.
    const streamed = frames
      .filter((f) => f.event === "delta")
      .map((f) => f.data.text as string)
      .join("");
    const done = frames.find((f) => f.event === "done")!;
    const message = done.data.message as { id: string; content: string; status: string };
    expect(message.status).toBe("complete");
    expect(streamed).toBe(message.content);

    const citations = done.data.citations as Array<Record<string, unknown>>;
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0].sourceId).toBe(widgetDocId);

    // Persisted state matches: exactly one complete assistant message + its citations.
    const stored = await db("messages").where({ conversation_id: conversationId, role: "assistant" });
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("complete");
    expect(stored[0].content).toBe(message.content);
    const storedCites = await db("message_citations").where({ message_id: message.id });
    expect(storedCites.length).toBe(citations.length);
  });

  it("returns the insufficient-knowledge answer without starting a token stream", async () => {
    const conversationId = await newConversation(adminCookie);
    const res = await request(app)
      .post(`/assistant/conversations/${conversationId}/messages/stream`)
      .set("Cookie", adminCookie)
      .send({ content: "Explain lattice quantum chromodynamics renormalization schemes." });

    expect(res.status).toBe(200);
    const frames = parseSse(res.text);
    const types = frames.map((f) => f.event);
    expect(types).toEqual(["user", "insufficient"]); // no delta, no LLM stream
    const message = frames[1].data.message as { id: string; content: string };
    expect(message.content.toLowerCase()).toContain("knowledge base");

    // No fabricated citations were stored.
    const storedCites = await db("message_citations").where({ message_id: message.id });
    expect(storedCites).toHaveLength(0);
  });

  it("rejects a foreign user with 404 and never opens a stream", async () => {
    const conversationId = await newConversation(adminCookie);
    const res = await request(app)
      .post(`/assistant/conversations/${conversationId}/messages/stream`)
      .set("Cookie", otherCookie)
      .send({ content: WIDGET_QUESTION });

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("requires authentication", async () => {
    const conversationId = await newConversation(adminCookie);
    const res = await request(app)
      .post(`/assistant/conversations/${conversationId}/messages/stream`)
      .send({ content: WIDGET_QUESTION });
    expect(res.status).toBe(401);
  });

  it("on provider failure mid-stream emits an error event and stores no complete answer", async () => {
    const conversationId = await newConversation(adminCookie);
    const failing: ChatProvider = {
      name: "failing",
      async generateAnswer() {
        throw new ProviderError("simulated upstream failure");
      },
      // eslint-disable-next-line require-yield
      async *generateAnswerStream() {
        throw new ProviderError("simulated upstream failure");
      }
    };

    const events: Array<{ type: string }> = [];
    for await (const ev of streamAnswer(db, {
      conversationId,
      userId: adminId,
      question: WIDGET_QUESTION,
      chatProvider: failing
    })) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("user");
    expect(types).toContain("error");
    expect(types).not.toContain("done");

    const assistant = await db("messages").where({ conversation_id: conversationId, role: "assistant" });
    expect(assistant).toHaveLength(1);
    expect(assistant[0].status).toBe("error");
    expect(assistant.some((m) => m.status === "complete")).toBe(false);
    const cites = await db("message_citations").whereIn(
      "message_id",
      assistant.map((m) => m.id)
    );
    expect(cites).toHaveLength(0);
  });

  it("on client disconnect mid-stream stops and persists no assistant message", async () => {
    const conversationId = await newConversation(adminCookie);
    const controller = new AbortController();
    const slow: ChatProvider = {
      name: "slow",
      async generateAnswer() {
        return { text: "unused" };
      },
      async *generateAnswerStream(_input, signal) {
        yield "partial ";
        for (let i = 0; i < 10; i++) {
          if (signal?.aborted) return;
          yield "more ";
        }
      }
    };

    const events: Array<{ type: string }> = [];
    for await (const ev of streamAnswer(db, {
      conversationId,
      userId: adminId,
      question: WIDGET_QUESTION,
      chatProvider: slow,
      signal: controller.signal
    })) {
      events.push(ev);
      if (ev.type === "delta") controller.abort(); // client goes away mid-stream
    }

    const types = events.map((e) => e.type);
    expect(types).not.toContain("done"); // never finalized
    expect(types).not.toContain("error"); // a disconnect is not a provider failure

    // Nothing was persisted as an assistant answer (partial or otherwise).
    const assistant = await db("messages").where({ conversation_id: conversationId, role: "assistant" });
    expect(assistant).toHaveLength(0);
    // The user turn is still recorded.
    const user = await db("messages").where({ conversation_id: conversationId, role: "user" });
    expect(user).toHaveLength(1);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { type Knex } from "knex";
import crypto from "node:crypto";
import { createApp } from "../app.js";
import { connectAndMigrate } from "./helpers/testDb.js";

/**
 * HTTP-level tests for conversation management (list / rename / delete) and the
 * per-user isolation guarantees, against a real Postgres (pgvector) test database.
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

suite("Conversation management integration", () => {
  let db: Knex;
  let app: ReturnType<typeof createApp>;
  let userId: string;
  let userCookie: string;
  let otherCookie: string;

  const convoDocId = `convo-widget-${crypto.randomUUID()}`;
  const QUESTION = "How do I calibrate a Nimbus sensor?";

  async function createUserWithSession(role: "admin" | "member"): Promise<{ id: string; cookie: string }> {
    const id = crypto.randomUUID();
    await db("users").insert({
      id,
      email: `${role}-${id}@test.local`,
      name: `${role} user`,
      role,
      password_hash: "x"
    });
    const sessionId = crypto.randomUUID();
    await db("sessions").insert({ id: sessionId, user_id: id, expires_at: new Date(Date.now() + 86_400_000) });
    return { id, cookie: `ac_session=${sessionId}` };
  }

  async function newConversation(cookie: string, title?: string): Promise<string> {
    const res = await request(app)
      .post("/assistant/conversations")
      .set("Cookie", cookie)
      .send(title ? { title } : {});
    expect(res.status).toBe(201);
    return res.body.data.conversation.id as string;
  }

  beforeAll(async () => {
    db = await connectAndMigrate(TEST_DB!);
    app = createApp(db);
    const admin = await createUserWithSession("admin");
    userId = admin.id;
    userCookie = admin.cookie;
    const other = await createUserWithSession("member");
    otherCookie = other.cookie;

    // Purge docs left by a prior run of this suite (the test DB is persistent and
    // shared, and each run ingests a fresh convo-widget-<uuid> doc). Chunks and
    // citations cascade on delete.
    await db("kb_documents").where("source_id", "like", "convo-widget-%").del();

    // A document so an asked question produces real citations we can assert
    // cascade-delete against.
    const ingest = await request(app)
      .post("/assistant/knowledge/ingest?filename=sensors.jsonl")
      .set("Cookie", userCookie)
      .set("content-type", "text/plain")
      .send(
        exportLine({
          id: convoDocId,
          title: "Nimbus sensor calibration",
          body: "To calibrate a Nimbus sensor, open the diagnostics panel and run the guided calibration wizard."
        })
      );
    expect(ingest.body.data.ingestion.status).toBe("succeeded");
  }, 60_000);

  afterAll(async () => {
    // Leave the shared test DB clean so the next run starts without stale docs.
    if (db) {
      await db("kb_documents").where("source_id", "like", "convo-widget-%").del();
      await db.destroy();
    }
  });

  it("lists only the current user's conversations, newest activity first, with message counts", async () => {
    const first = await newConversation(userCookie, "First");
    const second = await newConversation(userCookie, "Second");
    // Activity on `first` should float it above `second` (ordered by updated_at).
    await request(app)
      .post(`/assistant/conversations/${first}/messages`)
      .set("Cookie", userCookie)
      .send({ content: QUESTION });

    // A conversation owned by another user must not appear in this user's list.
    await newConversation(otherCookie, "Not mine");

    const res = await request(app).get("/assistant/conversations").set("Cookie", userCookie);
    expect(res.status).toBe(200);
    const items = res.body.data.items as Array<{ id: string; title: string; messageCount: number }>;

    const ids = items.map((c) => c.id);
    expect(ids).toContain(first);
    expect(ids).toContain(second);
    // Isolation: none of the listed conversations belong to the other user.
    const owned = await db("conversations").where({ user_id: userId }).pluck("id");
    for (const c of items) expect(owned).toContain(c.id);

    // `first` (which has activity) sorts ahead of `second`.
    expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second));

    const firstRow = items.find((c) => c.id === first)!;
    expect(firstRow.messageCount).toBeGreaterThanOrEqual(2); // user + assistant
    const secondRow = items.find((c) => c.id === second)!;
    expect(secondRow.messageCount).toBe(0);
  });

  it("renames a conversation and persists the new title", async () => {
    const id = await newConversation(userCookie, "Before");
    const res = await request(app)
      .patch(`/assistant/conversations/${id}`)
      .set("Cookie", userCookie)
      .send({ title: "After rename" });
    expect(res.status).toBe(200);
    expect(res.body.data.conversation.title).toBe("After rename");

    const opened = await request(app).get(`/assistant/conversations/${id}`).set("Cookie", userCookie);
    expect(opened.body.data.conversation.title).toBe("After rename");
  });

  it("rejects an empty rename title with a validation error", async () => {
    const id = await newConversation(userCookie);
    const res = await request(app)
      .patch(`/assistant/conversations/${id}`)
      .set("Cookie", userCookie)
      .send({ title: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("deletes a conversation and cascades its messages and citations", async () => {
    const id = await newConversation(userCookie);
    const ask = await request(app)
      .post(`/assistant/conversations/${id}/messages`)
      .set("Cookie", userCookie)
      .send({ content: QUESTION });
    expect(ask.status).toBe(201);
    const assistantMessageId = ask.body.data.message.id as string;
    expect((ask.body.data.citations as unknown[]).length).toBeGreaterThan(0);

    const del = await request(app).delete(`/assistant/conversations/${id}`).set("Cookie", userCookie);
    expect(del.status).toBe(200);

    // Gone from the list and no longer openable.
    const opened = await request(app).get(`/assistant/conversations/${id}`).set("Cookie", userCookie);
    expect(opened.status).toBe(404);

    // Messages and citations cascaded away.
    const messages = await db("messages").where({ conversation_id: id });
    expect(messages).toHaveLength(0);
    const citations = await db("message_citations").where({ message_id: assistantMessageId });
    expect(citations).toHaveLength(0);
  });

  it("prevents cross-user rename and delete (foreign conversation -> 404)", async () => {
    const id = await newConversation(userCookie, "Owned by user");

    const foreignRename = await request(app)
      .patch(`/assistant/conversations/${id}`)
      .set("Cookie", otherCookie)
      .send({ title: "hijacked" });
    expect(foreignRename.status).toBe(404);

    const foreignDelete = await request(app)
      .delete(`/assistant/conversations/${id}`)
      .set("Cookie", otherCookie);
    expect(foreignDelete.status).toBe(404);

    // The conversation is untouched: still owned, still original title.
    const row = await db("conversations").where({ id }).first();
    expect(row.user_id).toBe(userId);
    expect(row.title).toBe("Owned by user");
  });

  it("treats a malformed conversation id as not found (404, not a 500)", async () => {
    const badId = "not-a-uuid";
    const open = await request(app).get(`/assistant/conversations/${badId}`).set("Cookie", userCookie);
    expect(open.status).toBe(404);
    expect(open.body.error.code).toBe("NOT_FOUND");

    const rename = await request(app)
      .patch(`/assistant/conversations/${badId}`)
      .set("Cookie", userCookie)
      .send({ title: "x" });
    expect(rename.status).toBe(404);

    const del = await request(app).delete(`/assistant/conversations/${badId}`).set("Cookie", userCookie);
    expect(del.status).toBe(404);

    const ask = await request(app)
      .post(`/assistant/conversations/${badId}/messages`)
      .set("Cookie", userCookie)
      .send({ content: QUESTION });
    expect(ask.status).toBe(404);
  });

  it("requires authentication for list, rename, and delete", async () => {
    const id = await newConversation(userCookie);
    expect((await request(app).get("/assistant/conversations")).status).toBe(401);
    expect((await request(app).patch(`/assistant/conversations/${id}`).send({ title: "x" })).status).toBe(401);
    expect((await request(app).delete(`/assistant/conversations/${id}`)).status).toBe(401);
  });
});

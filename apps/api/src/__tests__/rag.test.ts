import { describe, it, expect } from "vitest";
import {
  buildGroundedPrompt,
  buildContextBlock,
  INSUFFICIENT_KNOWLEDGE_MESSAGE,
  type RetrievedContext
} from "../lib/knowledge/prompt.js";
import { LocalChatProvider } from "../lib/knowledge/provider.js";
import { dedupeContextsByDocument } from "../lib/knowledge/rag.js";

function ctx(overrides: Partial<RetrievedContext> = {}): RetrievedContext {
  return {
    documentId: "doc-1",
    chunkId: "chunk-1",
    sourceType: "docs",
    sourceId: "src-1",
    title: "Password reset",
    content: "To reset your password, use the SSO recovery flow.",
    score: 0.42,
    ...overrides
  };
}

describe("buildContextBlock / buildGroundedPrompt", () => {
  it("numbers contexts so inline [n] citations line up with them", () => {
    const block = buildContextBlock([ctx({ title: "A" }), ctx({ title: "B", content: "second" })]);
    expect(block).toMatch(/\[1\] \(A — docs\)/);
    expect(block).toMatch(/\[2\] \(B — docs\)/);
    expect(block).toContain("second");
  });

  it("produces a system rule against fabrication, includes context and the question", () => {
    const messages = buildGroundedPrompt("How do I reset my password?", [ctx()]);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content.toLowerCase()).toContain("do not");
    const user = messages[messages.length - 1];
    expect(user.role).toBe("user");
    expect(user.content).toContain("SSO recovery flow");
    expect(user.content).toContain("How do I reset my password?");
  });

  it("threads prior history between the system prompt and the new question", () => {
    const history = [
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "earlier answer" }
    ];
    const messages = buildGroundedPrompt("follow up", [ctx()], history);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});

describe("LocalChatProvider", () => {
  it("grounds its answer strictly in the retrieved chunks with matching [n] markers", async () => {
    const provider = new LocalChatProvider();
    const { text } = await provider.generateAnswer({
      question: "How do I reset my password?",
      contexts: [ctx()],
      history: []
    });
    expect(text).toContain("SSO recovery flow"); // extracted from the chunk, not invented
    expect(text).toContain("[1]");
    expect(text).toContain("Password reset (docs)");
  });

  it("is deterministic for the same input", async () => {
    const provider = new LocalChatProvider();
    const input = { question: "q", contexts: [ctx()], history: [] };
    const a = await provider.generateAnswer(input);
    const b = await provider.generateAnswer(input);
    expect(a.text).toBe(b.text);
  });
});

describe("dedupeContextsByDocument", () => {
  it("keeps the highest-scoring chunk per document and sorts by score desc", () => {
    const contexts = [
      ctx({ documentId: "d1", chunkId: "c1", score: 0.3 }),
      ctx({ documentId: "d1", chunkId: "c2", score: 0.7 }),
      ctx({ documentId: "d2", chunkId: "c3", score: 0.5 })
    ];
    const result = dedupeContextsByDocument(contexts);
    expect(result).toHaveLength(2);
    expect(result[0].documentId).toBe("d1");
    expect(result[0].chunkId).toBe("c2"); // the 0.7 chunk won
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });
});

describe("insufficient-knowledge message", () => {
  it("is an explicit, non-answer that points at ingestion", () => {
    expect(INSUFFICIENT_KNOWLEDGE_MESSAGE.toLowerCase()).toContain("knowledge base");
    expect(INSUFFICIENT_KNOWLEDGE_MESSAGE.toLowerCase()).toContain("ingest");
  });
});

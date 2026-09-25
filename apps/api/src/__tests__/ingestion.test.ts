import { describe, it, expect } from "vitest";
import { parseJsonl } from "../lib/knowledge/parseJsonl.js";
import { validateUpload } from "../lib/knowledge/uploadValidation.js";
import { normalizeExportRow, metadataToText, exportRowSchema } from "../lib/knowledge/normalize.js";
import { chunkText } from "../lib/knowledge/chunk.js";
import { classifyDocument, validateAndNormalize, toVectorLiteral } from "../lib/knowledge/ingest.js";
import { LocalEmbeddingProvider } from "../lib/knowledge/provider.js";

const MB = 1024 * 1024;

function exportLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "doc-1",
    type: "docs",
    title: "Getting Started",
    category: "getting-started",
    body: "Welcome to Adamant SaaS.",
    metadata_json: { reading_time_minutes: 5, difficulty: "beginner" },
    tags: ["onboarding"],
    owner_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-15T00:00:00.000Z",
    ...overrides
  });
}

describe("parseJsonl", () => {
  it("parses valid JSONL lines", () => {
    const text = `${exportLine({ id: "a" })}\n${exportLine({ id: "b" })}`;
    const res = parseJsonl(text);
    expect(res.records).toHaveLength(2);
    expect(res.errors).toHaveLength(0);
    expect(res.totalLines).toBe(2);
  });

  it("ignores blank and whitespace-only lines", () => {
    const text = `\n${exportLine({ id: "a" })}\n   \n\n${exportLine({ id: "b" })}\n`;
    const res = parseJsonl(text);
    expect(res.records).toHaveLength(2);
    expect(res.errors).toHaveLength(0);
  });

  it("reports malformed lines with 1-based line number and skips them", () => {
    const text = [
      exportLine({ id: "a" }), // line 1
      "{ this is not json", // line 2
      exportLine({ id: "b" }) // line 3
    ].join("\n");

    const res = parseJsonl(text);
    expect(res.records).toHaveLength(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].line).toBe(2);
    expect(res.errors[0].error).toMatch(/.+/); // has a message
  });

  it("keeps correct line numbers across CRLF newlines", () => {
    const text = `${exportLine({ id: "a" })}\r\nBROKEN\r\n${exportLine({ id: "b" })}`;
    const res = parseJsonl(text);
    expect(res.errors[0].line).toBe(2);
  });
});

describe("validateUpload", () => {
  const base = { maxBytes: 5 * MB };

  it("accepts a valid .jsonl file", () => {
    expect(validateUpload({ ...base, filename: "docs.jsonl", content: exportLine() }).ok).toBe(true);
  });

  it("accepts .ndjson as well", () => {
    expect(validateUpload({ ...base, filename: "docs.ndjson", content: exportLine() }).ok).toBe(true);
  });

  it("rejects unsupported formats with a clear message", () => {
    const res = validateUpload({ ...base, filename: "docs.csv", content: "a,b,c" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/Unsupported file format/i);
  });

  it("rejects an empty file", () => {
    const res = validateUpload({ ...base, filename: "docs.jsonl", content: "   \n  " });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/empty/i);
  });

  it("rejects an oversized file with the limit in the message", () => {
    const res = validateUpload({ filename: "docs.jsonl", content: "x".repeat(2 * MB), maxBytes: 1 * MB });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/exceeds the maximum/i);
  });

  it("requires a filename", () => {
    expect(validateUpload({ ...base, filename: "", content: exportLine() }).ok).toBe(false);
  });
});

describe("normalizeExportRow — metadata preservation & flattening", () => {
  it("preserves source metadata for traceability", () => {
    const row = exportRowSchema.parse(JSON.parse(exportLine({ id: "doc-42" })));
    const doc = normalizeExportRow(row, { filename: "docs.jsonl" });

    expect(doc.sourceType).toBe("docs");
    expect(doc.sourceId).toBe("doc-42");
    expect(doc.metadataJson.filename).toBe("docs.jsonl");
    expect(doc.metadataJson.module_type).toBe("docs");
    expect(doc.metadataJson.source_id).toBe("doc-42");
    expect(doc.metadataJson.original_updated_at).toBe("2026-01-15T00:00:00.000Z");
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flattens nested support conversation messages into searchable text", () => {
    const row = exportRowSchema.parse({
      id: "sup-1",
      type: "support",
      title: "Cannot log in",
      metadata_json: {
        ticket_id: "TKT-100",
        resolved: true,
        messages: [
          { role: "customer", content: "I cannot reset my password" },
          { role: "agent", content: "Please use the SSO recovery flow" }
        ]
      }
    });
    const doc = normalizeExportRow(row);
    expect(doc.content).toContain("I cannot reset my password");
    expect(doc.content).toContain("SSO recovery flow");
    expect(doc.content).toContain("TKT-100");
  });

  it("flattens playbook steps and incident timelines", () => {
    const playbook = normalizeExportRow(
      exportRowSchema.parse({
        id: "pb-1",
        type: "playbooks",
        title: "DB Failover",
        metadata_json: { steps: [{ title: "Promote replica", description: "Run failover script" }] }
      })
    );
    expect(playbook.content).toContain("Promote replica");
    expect(playbook.content).toContain("Run failover script");

    const incident = normalizeExportRow(
      exportRowSchema.parse({
        id: "inc-1",
        type: "incidents",
        title: "API outage",
        metadata_json: {
          root_cause: "connection pool exhaustion",
          timeline: [{ time: "10:00", event: "alerts fired" }]
        }
      })
    );
    expect(incident.content).toContain("connection pool exhaustion");
    expect(incident.content).toContain("alerts fired");
  });

  it("metadataToText handles arrays of objects and nested keys", () => {
    const lines = metadataToText({ a: { b: 1 }, list: [{ x: "one" }, { x: "two" }] });
    const joined = lines.join("\n");
    expect(joined).toContain("1");
    expect(joined).toContain("one");
    expect(joined).toContain("two");
  });
});

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const chunks = chunkText("hello world");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].content).toBe("hello world");
  });

  it("returns [] for empty text", () => {
    expect(chunkText("   ")).toHaveLength(0);
  });

  it("splits long text into ordered, overlapping chunks", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} about knowledge.`).join(" ");
    const chunks = chunkText(text, { chunkSize: 500, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
    expect(chunks.every((c) => c.content.length > 0)).toBe(true);
  });
});

describe("classifyDocument — dedup / update decisions", () => {
  it("inserts when there is no existing document", () => {
    expect(classifyDocument(undefined, "hash-a")).toBe("insert");
    expect(classifyDocument(null, "hash-a")).toBe("insert");
  });

  it("skips when the content hash is unchanged", () => {
    expect(classifyDocument("hash-a", "hash-a")).toBe("skip");
  });

  it("updates when the content hash changed", () => {
    expect(classifyDocument("hash-a", "hash-b")).toBe("update");
  });
});

describe("validateAndNormalize", () => {
  it("normalizes valid records and reports invalid ones per line", () => {
    const records = [
      { line: 1, data: JSON.parse(exportLine({ id: "ok" })) },
      { line: 2, data: { id: "bad", title: "missing type" } }, // invalid: no type
      { line: 3, data: { id: "x", type: "not_a_type", title: "bad type" } } // invalid enum
    ];
    const res = validateAndNormalize(records);
    expect(res.valid).toHaveLength(1);
    expect(res.valid[0].doc.sourceId).toBe("ok");
    expect(res.errors).toHaveLength(2);
    expect(res.errors.map((e) => e.line)).toEqual([2, 3]);
  });
});

describe("LocalEmbeddingProvider", () => {
  it("is deterministic and emits the configured dimension", async () => {
    const provider = new LocalEmbeddingProvider(32);
    const [a] = await provider.embed(["knowledge base retrieval"]);
    const [b] = await provider.embed(["knowledge base retrieval"]);
    expect(a).toHaveLength(32);
    expect(a).toEqual(b);
  });

  it("produces L2-normalized vectors (unit length) for non-empty text", async () => {
    const provider = new LocalEmbeddingProvider(64);
    const [v] = await provider.embed(["adamant saas knowledge assistant"]);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("maps different texts to different vectors", async () => {
    const provider = new LocalEmbeddingProvider(64);
    const [a] = await provider.embed(["password reset flow"]);
    const [b] = await provider.embed(["billing and invoices"]);
    expect(a).not.toEqual(b);
  });
});

describe("toVectorLiteral", () => {
  it("formats a number array as a pgvector literal", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
  });
});

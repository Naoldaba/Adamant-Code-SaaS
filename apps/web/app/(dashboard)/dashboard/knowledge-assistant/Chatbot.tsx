"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { apiBaseUrl, apiFetch } from "../../../../lib/apiClient";

// Mirrors CitationOut from the API (apps/api/src/lib/knowledge/rag.ts).
type Citation = {
  id: string;
  documentId: string | null;
  chunkId: string | null;
  sourceType: string;
  sourceId: string | null;
  title: string;
  score: number;
  snippet: string | null;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "error";
  created_at: string;
  citations: Citation[];
  // True while the assistant answer is still being streamed in; cleared on the
  // final `done`/`insufficient` event. Purely a UI hint (typing indicator).
  streaming?: boolean;
};

// Events emitted by POST /assistant/conversations/:id/messages/stream (SSE). Mirror
// AnswerStreamEvent in apps/api/src/lib/knowledge/rag.ts.
type StreamEvent =
  | { type: "user"; userMessage: Message }
  | { type: "insufficient"; message: Message }
  | { type: "delta"; text: string }
  | { type: "done"; message: Message; citations: Citation[] }
  | { type: "error"; message: string };

type ConversationSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messageCount: number;
};

// source_type → knowledge module route slug. Most map 1:1; the three underscored
// types use hyphenated slugs. `upload` (free-form) has no module detail page, so
// its citations render without a deep link.
const SOURCE_TYPE_TO_SLUG: Record<string, string> = {
  docs: "docs",
  policies: "policies",
  api_reference: "api-reference",
  changelog: "changelog",
  incidents: "incidents",
  support: "support",
  feature_flags: "feature-flags",
  analytics_events: "analytics-events",
  playbooks: "playbooks"
};

function citationHref(c: Citation): string | null {
  const slug = SOURCE_TYPE_TO_SLUG[c.sourceType];
  if (!slug || !c.sourceId) return null;
  return `/dashboard/knowledge/${slug}/${c.sourceId}`;
}

/**
 * POST a question to the streaming endpoint and invoke `onEvent` for each parsed
 * SSE event. The endpoint returns text/event-stream on success; auth/ownership
 * failures come back as the standard JSON error envelope (non-2xx), which is thrown
 * as an Error so the caller can surface it exactly like the other API calls.
 */
async function streamMessage(
  conversationId: string,
  content: string,
  onEvent: (ev: StreamEvent) => void
): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/assistant/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!res.ok || !res.body) {
    // Error envelope (e.g. 401/404/validation) — never an SSE stream.
    const text = await res.text().catch(() => "");
    let message = `Request failed (${res.status})`;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* keep the status-based fallback */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // SSE frames are separated by a blank line; each frame carries a `data:` payload.
  const flushFrame = (frame: string) => {
    const dataLines = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) return;
    try {
      onEvent(JSON.parse(dataLines.join("\n")) as StreamEvent);
    } catch {
      /* ignore malformed frame */
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      flushFrame(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
  }
  if (buffer.trim()) flushFrame(buffer);
}

export function Chatbot() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // activeId === null means a fresh draft chat: no conversation exists yet; it is
  // created on the first send so the sidebar never fills with empty conversations.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const threadEndRef = useRef<HTMLDivElement>(null);

  async function loadConversations() {
    setListLoading(true);
    setListError(null);
    try {
      const res = await apiFetch<{ items: ConversationSummary[] }>("/assistant/conversations?pageSize=100");
      setConversations(res.items);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to load conversations");
    } finally {
      setListLoading(false);
    }
  }

  useEffect(() => {
    loadConversations();
  }, []);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function openConversation(id: string) {
    setActiveId(id);
    setThreadError(null);
    setThreadLoading(true);
    setMessages([]);
    try {
      const res = await apiFetch<{ messages: Message[] }>(`/assistant/conversations/${id}`);
      setMessages(res.messages);
    } catch (e) {
      setThreadError(e instanceof Error ? e.message : "Failed to load conversation");
    } finally {
      setThreadLoading(false);
    }
  }

  function startNewChat() {
    setActiveId(null);
    setMessages([]);
    setThreadError(null);
    setInput("");
  }

  async function handleSend() {
    const question = input.trim();
    if (!question || sending) return;
    setSending(true);
    setThreadError(null);

    // Optimistically show the user's message while the answer is generated.
    const optimistic: Message = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      content: question,
      status: "complete",
      created_at: new Date().toISOString(),
      citations: []
    };
    setMessages((prev) => [...prev, optimistic]);
    setInput("");

    // A stable placeholder for the assistant turn that fills in as deltas stream.
    const streamingId = `streaming-${Date.now()}`;

    // Declared outside the try so the catch can re-sync the correct conversation,
    // including one just created lazily in this same call (activeId is still stale
    // in this closure at that point).
    let conversationId = activeId;
    let streamOpened = false;

    try {
      // Create the conversation lazily on the first message of a draft chat.
      if (!conversationId) {
        const created = await apiFetch<{ conversation: { id: string } }>("/assistant/conversations", {
          method: "POST",
          body: JSON.stringify({})
        });
        conversationId = created.conversation.id;
        setActiveId(conversationId);
      }

      await streamMessage(conversationId, question, (ev) => {
        switch (ev.type) {
          case "user":
            // Swap the optimistic user turn for the persisted one (real id).
            setMessages((prev) =>
              prev.map((m) => (m.id === optimistic.id ? { ...ev.userMessage, citations: [] } : m))
            );
            // Add the streaming assistant placeholder once the user turn is confirmed.
            setMessages((prev) => [
              ...prev,
              {
                id: streamingId,
                role: "assistant",
                content: "",
                status: "complete",
                created_at: new Date().toISOString(),
                citations: [],
                streaming: true
              }
            ]);
            streamOpened = true;
            break;
          case "delta":
            setMessages((prev) =>
              prev.map((m) => (m.id === streamingId ? { ...m, content: m.content + ev.text } : m))
            );
            break;
          case "insufficient":
            // Guardrail path: no tokens streamed; show the canned message as-is.
            setMessages((prev) =>
              prev.map((m) => (m.id === streamingId ? { ...ev.message, citations: [] } : m))
            );
            break;
          case "done":
            // Finalize: replace the placeholder with the persisted message + citations.
            setMessages((prev) =>
              prev.map((m) => (m.id === streamingId ? { ...ev.message, citations: ev.citations } : m))
            );
            break;
          case "error":
            // Provider failure mid-stream: drop the partial answer, show the error.
            setMessages((prev) => prev.filter((m) => m.id !== streamingId));
            setThreadError(ev.message);
            break;
        }
      });

      // Refresh the sidebar so the auto-generated title and new ordering appear.
      await loadConversations();
    } catch (e) {
      // Pre-stream failure (auth/ownership/network) or a dropped connection: no
      // answer is shown. The user turn may have been persisted server-side, so
      // re-sync from the server to reflect canonical state rather than a partial one.
      setThreadError(e instanceof Error ? e.message : "Failed to get an answer");
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id && m.id !== streamingId));
      if (conversationId && streamOpened) await openConversation(conversationId);
      await loadConversations();
    } finally {
      setSending(false);
    }
  }

  async function handleRename(id: string) {
    const title = renameValue.trim();
    if (!title) return;
    try {
      await apiFetch(`/assistant/conversations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title })
      });
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
      setRenamingId(null);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to rename conversation");
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      await apiFetch(`/assistant/conversations/${id}`, { method: "DELETE" });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) startNewChat();
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to delete conversation");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
      {/* Conversation list */}
      <Card>
        <CardHeader title="Conversations" subtitle="Your chat history" />
        <CardBody>
          <Button className="w-full" onClick={startNewChat}>
            + New conversation
          </Button>

          <div className="mt-3 space-y-1">
            {listLoading ? (
              <div className="text-sm text-slate-500">Loading…</div>
            ) : listError ? (
              <div className="text-sm text-red-600">{listError}</div>
            ) : conversations.length === 0 ? (
              <div className="text-sm text-slate-500">
                No conversations yet. Start a new one to ask the knowledge base a question.
              </div>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.id}
                  className={`group rounded-md px-2 py-1.5 text-sm ${
                    activeId === c.id ? "bg-slate-100" : "hover:bg-slate-50"
                  }`}
                >
                  {renamingId === c.id ? (
                    <div className="flex items-center gap-1">
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRename(c.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="w-full rounded border px-2 py-1 text-sm"
                      />
                      <button
                        onClick={() => handleRename(c.id)}
                        className="text-xs text-slate-600 hover:text-slate-900"
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-1">
                      <button
                        onClick={() => openConversation(c.id)}
                        className="flex-1 truncate text-left"
                        title={c.title}
                      >
                        {c.title}
                      </button>
                      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
                        <button
                          onClick={() => {
                            setRenamingId(c.id);
                            setRenameValue(c.title);
                          }}
                          className="text-xs text-slate-500 hover:text-slate-900"
                          title="Rename"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => handleDelete(c.id)}
                          className="text-xs text-red-500 hover:text-red-700"
                          title="Delete"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </CardBody>
      </Card>

      {/* Message thread + composer */}
      <Card>
        <CardHeader
          title={activeId ? conversations.find((c) => c.id === activeId)?.title ?? "Conversation" : "New conversation"}
          subtitle="Answers are grounded in the shared knowledge base and cite their sources"
        />
        <CardBody>
          <div className="flex h-[60vh] flex-col">
            <div className="flex-1 space-y-4 overflow-y-auto pr-1">
              {threadLoading ? (
                <div className="text-sm text-slate-500">Loading…</div>
              ) : messages.length === 0 ? (
                <div className="flex h-full items-center justify-center px-4 text-center text-sm text-slate-500">
                  Ask a question about the ingested knowledge base — for example, a policy,
                  incident postmortem, or API endpoint. The assistant answers only from ingested
                  content and shows the sources it used.
                </div>
              ) : (
                messages.map((m) => <MessageBubble key={m.id} message={m} />)
              )}
              <div ref={threadEndRef} />
            </div>

            {threadError && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {threadError}
              </div>
            )}

            <div className="mt-3 flex items-end gap-2 border-t pt-3">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                rows={2}
                placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
                disabled={sending}
                className="flex-1 resize-none rounded-md border px-3 py-2 text-sm disabled:opacity-60"
              />
              <Button onClick={handleSend} disabled={sending || input.trim().length === 0}>
                {sending ? "Thinking…" : "Send"}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

  // An assistant turn stored with status "error" is a recorded provider failure —
  // never render it as an answer.
  if (message.role === "assistant" && message.status === "error") {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        The assistant could not generate an answer for this turn.
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-900"
        }`}
      >
        {message.streaming && message.content.length === 0 ? (
          <div className="flex items-center gap-1 text-slate-500">
            <span className="animate-pulse">Thinking…</span>
          </div>
        ) : (
          <div className="whitespace-pre-wrap">
            {message.content}
            {message.streaming && <span className="ml-0.5 animate-pulse">▋</span>}
          </div>
        )}
        {message.citations.length > 0 && <Citations citations={message.citations} />}
      </div>
    </div>
  );
}

function Citations({ citations }: { citations: Citation[] }) {
  return (
    <div className="mt-2 border-t border-slate-200 pt-2">
      <div className="mb-1 text-xs font-medium text-slate-500">Sources</div>
      <div className="space-y-1.5">
        {citations.map((c, i) => {
          const href = citationHref(c);
          return (
            <div key={c.id} className="text-xs">
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                  {i + 1}
                </span>
                {href ? (
                  <Link href={href} className="font-medium text-slate-700 hover:underline">
                    {c.title}
                  </Link>
                ) : (
                  <span className="font-medium text-slate-700">{c.title}</span>
                )}
                <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-slate-400">
                  {c.sourceType}
                </span>
              </div>
              {c.snippet && <div className="mt-0.5 pl-6 text-slate-500">{c.snippet}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

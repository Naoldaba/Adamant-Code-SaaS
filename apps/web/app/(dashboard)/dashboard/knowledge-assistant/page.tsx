"use client";

import { useEffect, useState } from "react";
import { Page } from "../../../../components/layout/Page";
import { Card, CardBody, CardHeader } from "../../../../components/ui/Card";
import { apiFetch } from "../../../../lib/apiClient";
import { KnowledgeUploader } from "./KnowledgeUploader";

type MeUser = { id: string; email: string; name: string; role: "admin" | "member" };

type Tab = "chatbot" | "uploader";

export default function KnowledgeAssistantPage() {
  const [tab, setTab] = useState<Tab>("chatbot");
  const [me, setMe] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await apiFetch<{ user: MeUser }>("/auth/me");
        if (mounted) setMe(res.user);
      } catch {
        // RequireAuth (dashboard layout) already handles redirect on failure.
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const isAdmin = me?.role === "admin";

  return (
    <Page title="Knowledge Assistant" breadcrumbs="Dashboard / Knowledge Assistant">
      <div className="mb-4 flex gap-1 border-b">
        <TabButton active={tab === "chatbot"} onClick={() => setTab("chatbot")}>
          Chatbot
        </TabButton>
        <TabButton active={tab === "uploader"} onClick={() => setTab("uploader")}>
          Knowledge Uploader
        </TabButton>
      </div>

      {tab === "chatbot" ? (
        <Card>
          <CardHeader title="Chatbot" subtitle="Ask questions grounded in the shared knowledge base" />
          <CardBody>
            <div className="rounded-md bg-slate-50 border px-4 py-6 text-sm text-slate-500">
              The RAG chatbot is coming in a later phase. For now, use the Knowledge Uploader tab to
              populate the shared knowledge base by ingesting JSONL exports.
            </div>
          </CardBody>
        </Card>
      ) : loading ? (
        <Card>
          <CardBody>
            <div className="text-sm text-slate-500">Loading…</div>
          </CardBody>
        </Card>
      ) : (
        <KnowledgeUploader isAdmin={!!isAdmin} />
      )}
    </Page>
  );
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
        active ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

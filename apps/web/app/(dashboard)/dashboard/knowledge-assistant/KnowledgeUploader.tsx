"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { apiFetch, apiBaseUrl } from "../../../../lib/apiClient";

type IngestionStats = { total: number; inserted: number; updated: number; skipped: number; failed: number };
type LineError = { line: number; error: string };
type Ingestion = { id: string; status: string; stats: IngestionStats; errors: LineError[] };

type FileResult = { filename: string; ok: boolean; ingestion?: Ingestion; error?: string };

type KbSummary = { counts: Record<string, number>; totalDocuments: number; totalChunks: number };

type IngestionHistoryRow = {
  id: string;
  filename: string | null;
  source: string;
  status: string;
  stats_json: IngestionStats | Record<string, never>;
  errors_json: LineError[];
  created_at: string;
  completed_at: string | null;
};

const MODULE_TYPES = [
  "docs",
  "policies",
  "api_reference",
  "changelog",
  "incidents",
  "support",
  "feature_flags",
  "analytics_events",
  "playbooks"
] as const;

async function uploadJsonlFile(file: File): Promise<Ingestion> {
  // The file content is sent as the raw request body (text/plain) so it bypasses
  // the API's JSON body parser; the filename travels as a query parameter. We use
  // a dedicated fetch (not apiFetch) because apiFetch forces a JSON content-type.
  const text = await file.text();
  const res = await fetch(
    `${apiBaseUrl()}/assistant/knowledge/ingest?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "text/plain" },
      body: text
    }
  );
  const body = await res.text();
  const json = body ? JSON.parse(body) : null;
  if (!res.ok) {
    throw new Error(json?.error?.message ?? `Upload failed (${res.status})`);
  }
  return json.data.ingestion as Ingestion;
}

function StatBadge({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>
      {label}: {value}
    </span>
  );
}

function IngestionStatsRow({ stats }: { stats: IngestionStats }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <StatBadge label="Inserted" value={stats.inserted} tone="bg-green-100 text-green-800" />
      <StatBadge label="Updated" value={stats.updated} tone="bg-blue-100 text-blue-800" />
      <StatBadge label="Skipped" value={stats.skipped} tone="bg-slate-100 text-slate-700" />
      <StatBadge label="Failed" value={stats.failed} tone="bg-red-100 text-red-800" />
      <StatBadge label="Total" value={stats.total} tone="bg-slate-100 text-slate-700" />
    </div>
  );
}

export function KnowledgeUploader({ isAdmin }: { isAdmin: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);

  const [summary, setSummary] = useState<KbSummary | null>(null);
  const [history, setHistory] = useState<IngestionHistoryRow[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(true);

  async function refreshState() {
    setSummaryLoading(true);
    try {
      const s = await apiFetch<KbSummary>("/assistant/knowledge/documents");
      setSummary(s);
      if (isAdmin) {
        const h = await apiFetch<{ items: IngestionHistoryRow[] }>("/assistant/knowledge/ingestions");
        setHistory(h.items);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load knowledge base state");
    } finally {
      setSummaryLoading(false);
    }
  }

  useEffect(() => {
    refreshState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader title="Knowledge Uploader" subtitle="Admin-only" />
        <CardBody>
          <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            The Knowledge Uploader is restricted to administrators. The shared knowledge base is
            still searchable from the Chatbot tab.
          </div>
        </CardBody>
      </Card>
    );
  }

  async function handleUpload() {
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    const collected: FileResult[] = [];
    for (const file of selected) {
      try {
        const ingestion = await uploadJsonlFile(file);
        collected.push({ filename: file.name, ok: true, ingestion });
      } catch (e) {
        collected.push({ filename: file.name, ok: false, error: e instanceof Error ? e.message : "Upload failed" });
      }
    }
    setResults(collected);
    setSelected([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setBusy(false);
    await refreshState();
  }

  async function handleIngestAllModules() {
    setBusy(true);
    setError(null);
    const collected: FileResult[] = [];
    for (const type of MODULE_TYPES) {
      try {
        const res = await apiFetch<{ ingestion: Ingestion }>(
          `/assistant/knowledge/ingest/from-module/${type}`,
          { method: "POST" }
        );
        collected.push({ filename: `${type} (module)`, ok: true, ingestion: res.ingestion });
      } catch (e) {
        collected.push({ filename: `${type} (module)`, ok: false, error: e instanceof Error ? e.message : "Ingest failed" });
      }
    }
    setResults(collected);
    setBusy(false);
    await refreshState();
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Knowledge Uploader"
          subtitle="Admin-only · ingest JSONL/NDJSON exports into the shared knowledge base"
        />
        <CardBody>
          <div className="space-y-4">
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".jsonl,.ndjson"
                multiple
                onChange={(e) => setSelected(Array.from(e.target.files ?? []))}
                className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
              />
              <p className="mt-2 text-xs text-slate-500">
                Supported formats: <code>.jsonl</code>, <code>.ndjson</code>. Re-uploading the same
                items updates them instead of creating duplicates. Content becomes searchable only
                after ingestion succeeds.
              </p>
            </div>

            {selected.length > 0 && (
              <ul className="text-sm text-slate-600">
                {selected.map((f) => (
                  <li key={f.name}>
                    {f.name} <span className="text-slate-400">({(f.size / 1024).toFixed(1)} KB)</span>
                  </li>
                ))}
              </ul>
            )}

            {error && <div className="text-sm text-red-600">{error}</div>}

            <div className="flex flex-wrap gap-2">
              <Button onClick={handleUpload} disabled={busy || selected.length === 0}>
                {busy ? "Ingesting…" : `Upload & ingest${selected.length ? ` (${selected.length})` : ""}`}
              </Button>
              <Button variant="secondary" onClick={handleIngestAllModules} disabled={busy}>
                {busy ? "Working…" : "Ingest all modules from DB"}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      {results.length > 0 && (
        <Card>
          <CardHeader title="Ingestion results" subtitle="Insert / update / skip / failure counts and per-line errors" />
          <CardBody>
            <div className="space-y-3">
              {results.map((r) => (
                <div key={r.filename} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">{r.filename}</span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        r.ok && r.ingestion?.status === "succeeded"
                          ? "bg-green-100 text-green-800"
                          : "bg-red-100 text-red-800"
                      }`}
                    >
                      {r.ok ? r.ingestion?.status : "error"}
                    </span>
                  </div>
                  {r.ok && r.ingestion ? (
                    <div className="mt-2 space-y-2">
                      <IngestionStatsRow stats={r.ingestion.stats} />
                      {r.ingestion.errors.length > 0 && (
                        <details className="text-xs text-slate-600">
                          <summary className="cursor-pointer text-red-600">
                            {r.ingestion.errors.length} line error(s)
                          </summary>
                          <ul className="mt-1 space-y-0.5">
                            {r.ingestion.errors.map((err, i) => (
                              <li key={i}>
                                Line {err.line}: {err.error}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  ) : (
                    <div className="mt-2 text-sm text-red-600">{r.error}</div>
                  )}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Knowledge base" subtitle="Ingested documents currently available to the chatbot" />
        <CardBody>
          {summaryLoading ? (
            <div className="text-sm text-slate-500">Loading…</div>
          ) : summary && summary.totalDocuments > 0 ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3 text-sm">
                <span className="font-medium">{summary.totalDocuments} documents</span>
                <span className="text-slate-500">{summary.totalChunks} chunks</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(summary.counts).map(([type, count]) => (
                  <span key={type} className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                    {type}: {count}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-500">
              The knowledge base is empty. Upload a JSONL export or ingest modules from the DB to
              populate it.
            </div>
          )}
        </CardBody>
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader title="Recent ingestions" subtitle="Ingestion run history" />
          <CardBody>
            <div className="space-y-2">
              {history.slice(0, 10).map((run) => {
                const stats = run.stats_json as IngestionStats;
                return (
                  <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-sm last:border-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          run.status === "succeeded"
                            ? "bg-green-100 text-green-800"
                            : run.status === "failed"
                              ? "bg-red-100 text-red-800"
                              : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {run.status}
                      </span>
                      <span className="text-slate-700">{run.filename ?? "—"}</span>
                      <span className="text-xs text-slate-400">{run.source}</span>
                    </div>
                    <div className="text-xs text-slate-500">
                      {typeof stats?.inserted === "number"
                        ? `+${stats.inserted} ~${stats.updated} =${stats.skipped} ✗${stats.failed}`
                        : "—"}{" "}
                      · {new Date(run.created_at).toLocaleString()}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

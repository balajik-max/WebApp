import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { UrbanFeature } from "../lib/types";
import {
  createReviewForFeature,
  fetchFeatureActivity,
  fetchReviewsForFeature,
  listFeatureVersions,
  updateReviewStatus,
  uploadFeatureVersion,
} from "../lib/workflow";
import { aiRecommend, type AiAnswer } from "../lib/ai";
import type { ActivityRow, FeatureVersion, ReviewItem, ReviewStatus } from "../lib/workflow";
import { ActivityTimeline } from "./ActivityTimeline";
import { CommentsThread } from "./CommentsThread";

interface Props {
  feature: UrbanFeature | null;
  onClose: () => void;
}

const NEXT_STATUS: Record<ReviewStatus, ReviewStatus | null> = {
  open: "reviewing", reviewing: "resolved", in_progress: "resolved", blocked: "reviewing", resolved: null, rejected: null,
};

const STATUS_LABEL: Record<ReviewStatus, string> = {
  open: "Open", reviewing: "Reviewing", in_progress: "In progress", blocked: "Blocked", resolved: "Resolved", rejected: "Rejected",
};

type TabId = "review" | "discussion" | "ai";

export function ArchitectWorkspace({ feature, onClose }: Props) {
  const [reviews, setReviews] = useState<ReviewItem[] | null>(null);
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [versions, setVersions] = useState<FeatureVersion[] | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyStatus, setBusyStatus] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("review");

  // AI Report state
  const [aiReport, setAiReport] = useState<AiAnswer | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [versionNote, setVersionNote] = useState("");
  const [versionBusy, setVersionBusy] = useState(false);

  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const featureId = feature?.properties.id ?? null;

  const refreshAll = useCallback(async (fid: string, signal?: AbortSignal) => {
    setError(null);
    try {
      const [rv, vs, act] = await Promise.all([
        fetchReviewsForFeature(fid, signal),
        listFeatureVersions(fid, signal),
        fetchFeatureActivity(fid, signal),
      ]);
      setReviews(rv);
      setVersions(vs);
      setActivity(act);
      setActiveReviewId((prev) => prev ?? rv[0]?.id ?? null);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!featureId) return;
    const ctrl = new AbortController();
    setReviews(null); setVersions(null); setActivity(null); setActiveReviewId(null);
    setAiReport(null); setAiError(null);
    void refreshAll(featureId, ctrl.signal);
    return () => ctrl.abort();
  }, [featureId, refreshAll]);

  // Fetch AI report when AI tab is selected
  const fetchAiReport = useCallback(async (fid: string) => {
    if (aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const answer = await aiRecommend({ feature_id: fid });
      setAiReport(answer);
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiLoading(false);
    }
  }, [aiLoading]);

  useEffect(() => {
    if (activeTab === "ai" && featureId && !aiReport && !aiLoading) {
      void fetchAiReport(featureId);
    }
  }, [activeTab, featureId, aiReport, aiLoading, fetchAiReport]);

  if (!feature || !featureId) return null;

  const activeReview = reviews?.find((r) => r.id === activeReviewId) ?? null;

  async function advanceStatus() {
    if (!activeReview) return;
    const next = NEXT_STATUS[activeReview.status];
    if (!next) return;
    setBusyStatus(true); setError(null);
    try {
      const updated = await updateReviewStatus(activeReview.id, next);
      setReviews((prev) => prev ? prev.map((r) => (r.id === updated.id ? updated : r)) : [updated]);
      if (featureId) await refreshAll(featureId);
    } catch (e) { setError((e as Error).message); } finally { setBusyStatus(false); }
  }

  async function createReview(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || !featureId) return;
    setCreateBusy(true); setError(null);
    try {
      const created = await createReviewForFeature(featureId, { title: newTitle.trim(), description: newDesc.trim() || undefined });
      setReviews((prev) => (prev ? [created, ...prev] : [created]));
      setActiveReviewId(created.id); setNewTitle(""); setNewDesc("");
      await refreshAll(featureId);
    } catch (e) { setError((e as Error).message); } finally { setCreateBusy(false); }
  }

  async function submitVersion(e: React.FormEvent) {
    e.preventDefault();
    if (!versionFile || !featureId) return;
    setVersionBusy(true); setError(null);
    try {
      await uploadFeatureVersion(featureId, versionFile, versionNote);
      setVersionFile(null); setVersionNote("");
      (document.getElementById("version-file-input") as HTMLInputElement | null)?.value &&
        ((document.getElementById("version-file-input") as HTMLInputElement).value = "");
      await refreshAll(featureId);
    } catch (e) { setError((e as Error).message); } finally { setVersionBusy(false); }
  }

  const props = feature.properties;
  const reviewCount = reviews?.length ?? 0;

  return (
    <aside className="workspace-panel" data-testid="architect-workspace">
      <header className="workspace-panel__head">
        <div>
          <div className="workspace-panel__eyebrow">Architect Workspace</div>
          <h2 className="workspace-panel__title" data-testid="workspace-title">
            {props.label ?? featureId.slice(0, 8)}
          </h2>
          <div className="workspace-panel__sub">
            {props.category ?? "uncategorized"} · severity{" "}
            <b>{props.severity.toFixed(2)}</b>
          </div>
        </div>
        <button type="button" className="workspace-panel__close" onClick={onClose} data-testid="workspace-close">×</button>
      </header>

      {error && (
        <div className="workspace-panel__error" data-testid="workspace-error">{error}</div>
      )}

      <div style={{ display: "flex", borderBottom: "1px solid var(--edge)" }}>
        {([
          { id: "review" as TabId, label: "Review", count: reviewCount },
          { id: "discussion" as TabId, label: "Discussion", count: activeReview ? 1 : 0 },
          { id: "ai" as TabId, label: "AI Report", count: 0 },
        ]).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, padding: "10px 12px", background: activeTab === tab.id ? "var(--surface-2)" : "transparent",
              border: "none", borderBottom: activeTab === tab.id ? "2px solid var(--accent)" : "2px solid transparent",
              color: activeTab === tab.id ? "var(--ink)" : "var(--ink-mute)",
              fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" as const,
              cursor: "pointer", transition: "all 0.15s ease",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {activeTab === "review" && (
          <div className="workspace-panel__section" data-testid="section-reviews">
            {reviews === null ? (
              <p className="workspace__muted">Loading…</p>
            ) : reviews.length === 0 ? (
              <p className="workspace__muted">No review items yet.</p>
            ) : (
              <ul className="review-list" data-testid="review-list">
                {reviews.map((r) => (
                  <li key={r.id} onClick={() => { setActiveReviewId(r.id); setActiveTab("discussion"); }}
                    className={r.id === activeReviewId ? "is-active" : ""} data-testid={`review-row-${r.id}`}>
                    <div className="review-list__title">{r.title}</div>
                    <span className={`badge badge--${r.status}`}>{STATUS_LABEL[r.status]}</span>
                  </li>
                ))}
              </ul>
            )}

            {activeReview && (
              <div className="review-actions" data-testid="review-actions">
                <button type="button" onClick={advanceStatus} disabled={busyStatus || !NEXT_STATUS[activeReview.status]} data-testid="advance-status">
                  {busyStatus ? "updating…" : NEXT_STATUS[activeReview.status] ? `Advance → ${STATUS_LABEL[NEXT_STATUS[activeReview.status] as ReviewStatus]}` : "Terminal state"}
                </button>
              </div>
            )}

            <form className="new-review" onSubmit={createReview} data-testid="new-review-form">
              <input data-testid="new-review-title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="new review title…" disabled={createBusy} />
              <input data-testid="new-review-desc" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="optional description" disabled={createBusy} />
              <button type="submit" disabled={createBusy || !newTitle.trim()} data-testid="new-review-submit">
                {createBusy ? "creating…" : "Create"}
              </button>
            </form>

            <div style={{ marginTop: 16 }}>
              <div className="workspace-panel__section-title">Design Versions</div>
              {versions === null ? (
                <p className="workspace__muted">Loading…</p>
              ) : versions.length === 0 ? (
                <p className="workspace__muted">No revised designs uploaded yet.</p>
              ) : (
                <ul className="versions" data-testid="version-list">
                  {versions.map((v) => (
                    <li key={v.id} data-testid={`version-row-${v.id}`}>
                      <div className="versions__badge">v{v.version}</div>
                      <div className="versions__body">
                        <div className="versions__file">{String(v.attributes?.filename ?? "unnamed")}</div>
                        {v.change_note && <div className="versions__note">{v.change_note}</div>}
                        <div className="versions__meta">{formatBytes(Number(v.attributes?.size_bytes ?? 0))} · {formatDate(v.created_at)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <form className="version-upload" onSubmit={submitVersion} data-testid="version-form">
                <input id="version-file-input" data-testid="version-file" type="file" onChange={(e) => setVersionFile(e.target.files?.[0] ?? null)} disabled={versionBusy} />
                <input data-testid="version-note" value={versionNote} onChange={(e) => setVersionNote(e.target.value)} placeholder="change note (optional)" disabled={versionBusy} />
                <button type="submit" disabled={versionBusy || !versionFile} data-testid="version-submit">
                  {versionBusy ? "uploading…" : "Upload Version"}
                </button>
              </form>
            </div>
          </div>
        )}

        {activeTab === "discussion" && activeReview && (
          <div className="workspace-panel__section" data-testid="section-comments">
            <CommentsThread reviewId={activeReview.id} />
          </div>
        )}

        {activeTab === "discussion" && !activeReview && (
          <div className="workspace-panel__section">
            <p className="workspace__muted">Select a review item to start discussion.</p>
          </div>
        )}

        {activeTab === "ai" && (
          <div className="workspace-panel__section" data-testid="section-ai" style={{ padding: 16 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as const, color: "var(--accent)", marginBottom: 8 }}>AI Analysis</div>
            
            {aiLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 20, color: "var(--ink-mute)", fontSize: 12 }}>
                <div className="ai-turn__dot" />
                <div className="ai-turn__dot" />
                <div className="ai-turn__dot" />
                <span>Analyzing feature with local AI...</span>
              </div>
            )}

            {aiError && (
              <div style={{ padding: 12, background: "var(--danger-muted)", border: "1px solid var(--danger)", borderRadius: "var(--radius-sm)", color: "var(--danger)", fontSize: 11, marginBottom: 12 }}>
                {aiError}
              </div>
            )}

            {!aiLoading && !aiError && !aiReport && (
              <button
                type="button"
                onClick={() => featureId && void fetchAiReport(featureId)}
                style={{
                  width: "100%", padding: "12px 16px", background: "var(--accent-muted)", border: "1px solid var(--accent)",
                  borderRadius: "var(--radius-sm)", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                  <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Run AI Analysis
              </button>
            )}

            {aiReport && (
              <div>
                {/* Model Info */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, fontSize: 10, color: "var(--ink-mute)" }}>
                  <span style={{ padding: "3px 8px", background: "var(--surface-2)", borderRadius: "var(--radius-full)" }}>
                    Model: <b style={{ color: "var(--ink-dim)" }}>{aiReport.model}</b>
                  </span>
                  <span style={{ padding: "3px 8px", background: "var(--surface-2)", borderRadius: "var(--radius-full)" }}>
                    Context: <b style={{ color: "var(--ink-dim)" }}>{aiReport.context_rows} rows</b>
                  </span>
                  <span style={{
                    padding: "3px 8px", borderRadius: "var(--radius-full)",
                    background: aiReport.grounded ? "var(--ok-muted)" : "var(--warn-muted)",
                    color: aiReport.grounded ? "var(--ok)" : "var(--warn)",
                    fontWeight: 600,
                  }}>
                    {aiReport.grounded ? "✓ Grounded" : "⚠ Insufficient data"}
                  </span>
                </div>

                {/* AI Answer */}
                <div style={{
                  padding: 16, background: "var(--surface-2)", border: "1px solid var(--edge)",
                  borderRadius: "var(--radius-md)", fontSize: 12, lineHeight: 1.6, color: "var(--ink)",
                }}>
                  <ReactMarkdown>{aiReport.answer_markdown}</ReactMarkdown>
                </div>

                {/* Disclaimer */}
                {aiReport.disclaimer && (
                  <div style={{ marginTop: 12, padding: "10px 12px", background: "var(--warn-muted)", borderRadius: "var(--radius-sm)", fontSize: 10, color: "var(--warn)" }}>
                    ⚠ {aiReport.disclaimer}
                  </div>
                )}

                {/* Refresh Button */}
                <button
                  type="button"
                  onClick={() => { setAiReport(null); featureId && void fetchAiReport(featureId); }}
                  style={{
                    marginTop: 12, width: "100%", padding: "8px 12px", background: "var(--surface-3)",
                    border: "1px solid var(--edge)", borderRadius: "var(--radius-sm)", color: "var(--ink-dim)",
                    fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  Refresh Analysis
                </button>
              </div>
            )}
          </div>
        )}

        <div className="workspace-panel__section" data-testid="section-activity">
          <div className="workspace-panel__section-title">Activity Timeline</div>
          <ActivityTimeline rows={activity} />
        </div>
      </div>
    </aside>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return iso; }
}

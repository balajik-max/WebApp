import { useCallback, useEffect, useState } from "react";
import type { UrbanFeature } from "../lib/types";
import {
  createReviewForFeature,
  fetchFeatureActivity,
  fetchReviewsForFeature,
  listFeatureVersions,
  updateReviewStatus,
  uploadFeatureVersion,
} from "../lib/workflow";
import type {
  ActivityRow,
  FeatureVersion,
  ReviewItem,
  ReviewStatus,
} from "../lib/workflow";
import { ActivityTimeline } from "./ActivityTimeline";
import { CommentsThread } from "./CommentsThread";

interface Props {
  feature: UrbanFeature | null;
  onClose: () => void;
}

const NEXT_STATUS: Record<ReviewStatus, ReviewStatus | null> = {
  open: "reviewing",
  reviewing: "resolved",
  in_progress: "resolved",
  blocked: "reviewing",
  resolved: null,
  rejected: null,
};

const STATUS_LABEL: Record<ReviewStatus, string> = {
  open: "Open",
  reviewing: "Reviewing",
  in_progress: "In progress",
  blocked: "Blocked",
  resolved: "Resolved",
  rejected: "Rejected",
};

export function ArchitectWorkspace({ feature, onClose }: Props) {
  const [reviews, setReviews] = useState<ReviewItem[] | null>(null);
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [versions, setVersions] = useState<FeatureVersion[] | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyStatus, setBusyStatus] = useState(false);

  // Version-upload form.
  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [versionNote, setVersionNote] = useState("");
  const [versionBusy, setVersionBusy] = useState(false);

  // Quick-create review form.
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const featureId = feature?.properties.id ?? null;

  const refreshAll = useCallback(
    async (fid: string, signal?: AbortSignal) => {
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
    },
    []
  );

  useEffect(() => {
    if (!featureId) return;
    const ctrl = new AbortController();
    setReviews(null);
    setVersions(null);
    setActivity(null);
    setActiveReviewId(null);
    void refreshAll(featureId, ctrl.signal);
    return () => ctrl.abort();
  }, [featureId, refreshAll]);

  if (!feature || !featureId) {
    return (
      <aside className="workspace-panel workspace-panel--empty" data-testid="workspace-empty">
        <div className="workspace-panel__hint">
          Click a feature on the map or a dataset in the left panel to open the
          architect workspace.
        </div>
      </aside>
    );
  }

  const activeReview = reviews?.find((r) => r.id === activeReviewId) ?? null;

  async function advanceStatus() {
    if (!activeReview) return;
    const next = NEXT_STATUS[activeReview.status];
    if (!next) return;
    setBusyStatus(true);
    setError(null);
    try {
      const updated = await updateReviewStatus(activeReview.id, next);
      setReviews((prev) =>
        prev ? prev.map((r) => (r.id === updated.id ? updated : r)) : [updated]
      );
      if (featureId) await refreshAll(featureId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyStatus(false);
    }
  }

  async function createReview(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || !featureId) return;
    setCreateBusy(true);
    setError(null);
    try {
      const created = await createReviewForFeature(featureId, {
        title: newTitle.trim(),
        description: newDesc.trim() || undefined,
      });
      setReviews((prev) => (prev ? [created, ...prev] : [created]));
      setActiveReviewId(created.id);
      setNewTitle("");
      setNewDesc("");
      await refreshAll(featureId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreateBusy(false);
    }
  }

  async function submitVersion(e: React.FormEvent) {
    e.preventDefault();
    if (!versionFile || !featureId) return;
    setVersionBusy(true);
    setError(null);
    try {
      await uploadFeatureVersion(featureId, versionFile, versionNote);
      setVersionFile(null);
      setVersionNote("");
      (document.getElementById("version-file-input") as HTMLInputElement | null)?.value &&
        ((document.getElementById("version-file-input") as HTMLInputElement).value = "");
      await refreshAll(featureId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVersionBusy(false);
    }
  }

  const props = feature.properties;

  return (
    <aside className="workspace-panel" data-testid="architect-workspace">
      <header className="workspace-panel__head">
        <div>
          <div className="workspace-panel__eyebrow">architect workspace</div>
          <h2 className="workspace-panel__title" data-testid="workspace-title">
            {props.label ?? featureId.slice(0, 8)}
          </h2>
          <div className="workspace-panel__sub">
            {props.category ?? "uncategorized"} · severity{" "}
            <b>{props.severity.toFixed(2)}</b>
          </div>
        </div>
        <button
          type="button"
          className="workspace-panel__close"
          onClick={onClose}
          data-testid="workspace-close"
        >
          ×
        </button>
      </header>

      {error && (
        <div className="workspace-panel__error" data-testid="workspace-error">
          {error}
        </div>
      )}

      {/* Reviews */}
      <Section title="Review items" testid="section-reviews">
        {reviews === null ? (
          <p className="workspace__muted">Loading…</p>
        ) : reviews.length === 0 ? (
          <p className="workspace__muted">No review items yet.</p>
        ) : (
          <ul className="review-list" data-testid="review-list">
            {reviews.map((r) => (
              <li
                key={r.id}
                onClick={() => setActiveReviewId(r.id)}
                className={r.id === activeReviewId ? "is-active" : ""}
                data-testid={`review-row-${r.id}`}
              >
                <div className="review-list__title">{r.title}</div>
                <span className={`badge badge--${r.status}`}>{STATUS_LABEL[r.status]}</span>
              </li>
            ))}
          </ul>
        )}

        {activeReview && (
          <div className="review-actions" data-testid="review-actions">
            <button
              type="button"
              onClick={advanceStatus}
              disabled={busyStatus || !NEXT_STATUS[activeReview.status]}
              data-testid="advance-status"
            >
              {busyStatus
                ? "updating…"
                : NEXT_STATUS[activeReview.status]
                ? `Advance → ${STATUS_LABEL[NEXT_STATUS[activeReview.status] as ReviewStatus]}`
                : "Terminal state"}
            </button>
          </div>
        )}

        <form className="new-review" onSubmit={createReview} data-testid="new-review-form">
          <input
            data-testid="new-review-title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="new review title…"
            disabled={createBusy}
          />
          <input
            data-testid="new-review-desc"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="optional description"
            disabled={createBusy}
          />
          <button type="submit" disabled={createBusy || !newTitle.trim()} data-testid="new-review-submit">
            {createBusy ? "creating…" : "Create"}
          </button>
        </form>
      </Section>

      {/* Comments */}
      {activeReview && (
        <Section title={`Discussion — ${activeReview.title}`} testid="section-comments">
          <CommentsThread reviewId={activeReview.id} />
        </Section>
      )}

      {/* Versions */}
      <Section title="Design versions" testid="section-versions">
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
                  <div className="versions__file">
                    {String(v.attributes?.filename ?? "unnamed")}
                  </div>
                  {v.change_note && <div className="versions__note">{v.change_note}</div>}
                  <div className="versions__meta">
                    {formatBytes(Number(v.attributes?.size_bytes ?? 0))} ·{" "}
                    {formatDate(v.created_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form className="version-upload" onSubmit={submitVersion} data-testid="version-form">
          <input
            id="version-file-input"
            data-testid="version-file"
            type="file"
            onChange={(e) => setVersionFile(e.target.files?.[0] ?? null)}
            disabled={versionBusy}
          />
          <input
            data-testid="version-note"
            value={versionNote}
            onChange={(e) => setVersionNote(e.target.value)}
            placeholder="change note (optional)"
            disabled={versionBusy}
          />
          <button
            type="submit"
            disabled={versionBusy || !versionFile}
            data-testid="version-submit"
          >
            {versionBusy ? "uploading…" : "Upload version"}
          </button>
        </form>
      </Section>

      {/* Activity */}
      <Section title="Activity timeline" testid="section-activity">
        <ActivityTimeline rows={activity} />
      </Section>
    </aside>
  );
}

function Section({
  title,
  testid,
  children,
}: {
  title: string;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <section className="workspace-panel__section" data-testid={testid}>
      <h4 className="workspace-panel__section-title">{title}</h4>
      {children}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

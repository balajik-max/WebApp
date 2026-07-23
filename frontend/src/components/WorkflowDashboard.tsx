import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useLanguage } from "../context/LanguageContext";
import {
  fetchAeTasks,
  fetchAeeActivity,
  type AiDetectionMode,
  type WorkflowDashboardItem,
  type WorkflowStatus,
} from "../lib/pointVerifications";

type DashboardKind = "tasks" | "activity";
type DashboardFilter = "all" | "action" | "waiting" | "completed";
type DetectionModeFilter = "all" | AiDetectionMode;

interface WorkflowDashboardProps {
  kind: DashboardKind;
}

const STATUS_META: Record<WorkflowStatus, { key: string; tone: string }> = {
  AI_DETECTED: { key: "workflow.status.aiDetected", tone: "neutral" },
  WORK_IN_PROGRESS: { key: "workflow.status.inProgress", tone: "progress" },
  PENDING_AEE_APPROVAL: { key: "workflow.status.waitingAee", tone: "warning" },
  RETURNED_BY_AEE: { key: "workflow.status.returned", tone: "danger" },
  AEE_APPROVED: { key: "workflow.status.aeeApproved", tone: "approved" },
  COMMISSIONER_ACCEPTED: { key: "workflow.status.accepted", tone: "complete" },
};

const DETECTION_MODE_LABEL: Record<AiDetectionMode, string> = {
  poles: "Poles",
  drains: "Drains",
  manholes: "Manholes",
  powerlines: "Powerlines",
  potholes: "Potholes",
  standing_water: "Standing Water",
};

const DETECTION_MODE_OPTIONS: AiDetectionMode[] = [
  "poles",
  "drains",
  "manholes",
  "powerlines",
  "potholes",
  "standing_water",
];

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatCoordinate(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(6) : "—";
}

function isActionRequired(kind: DashboardKind, status: WorkflowStatus): boolean {
  if (kind === "tasks") {
    return status === "WORK_IN_PROGRESS" || status === "RETURNED_BY_AEE";
  }
  return status === "PENDING_AEE_APPROVAL";
}

function isWaiting(kind: DashboardKind, status: WorkflowStatus): boolean {
  if (kind === "tasks") {
    return status === "PENDING_AEE_APPROVAL" || status === "AEE_APPROVED";
  }
  return status === "WORK_IN_PROGRESS" || status === "AEE_APPROVED" || status === "RETURNED_BY_AEE";
}

function actionLabel(
  kind: DashboardKind,
  item: WorkflowDashboardItem,
  t: (key: string) => string,
): string {
  if (kind === "tasks") {
    if (item.workflow_status === "WORK_IN_PROGRESS") return t("workflow.continueWork");
    if (item.workflow_status === "RETURNED_BY_AEE") return t("workflow.correctResubmit");
    return t("workflow.viewTask");
  }
  return item.workflow_status === "PENDING_AEE_APPROVAL"
    ? t("workflow.reviewNow")
    : t("workflow.viewActivity");
}

function EmptyState({ kind, t }: { kind: DashboardKind; t: (key: string) => string }) {
  return (
    <div className="workflow-dashboard__empty">
      <span className="workflow-dashboard__empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M9 11.5 11 13.5 15.5 9" />
          <path d="M5 4.5h14v15H5z" />
          <path d="M8 2.5h8v4H8z" />
        </svg>
      </span>
      <h2>{kind === "tasks" ? t("workflow.noAeTasks") : t("workflow.noAeeActivity")}</h2>
      <p>
        {kind === "tasks"
          ? t("workflow.noAeTasksHint")
          : t("workflow.noAeeActivityHint")}
      </p>
    </div>
  );
}

export function WorkflowDashboard({ kind }: WorkflowDashboardProps) {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [items, setItems] = useState<WorkflowDashboardItem[]>([]);
  const [filter, setFilter] = useState<DashboardFilter>("all");
  const [modeFilter, setModeFilter] = useState<DetectionModeFilter>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (background = false, signal?: AbortSignal) => {
    background ? setRefreshing(true) : setLoading(true);
    try {
      const next = kind === "tasks"
        ? await fetchAeTasks(signal)
        : await fetchAeeActivity(signal);
      setItems(next);
      setError(null);
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") {
        setError(t("workflow.loadError"));
      }
    } finally {
      background ? setRefreshing(false) : setLoading(false);
    }
  }, [kind, t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    const timer = window.setInterval(() => void load(true), 30_000);
    const refresh = () => void load(true);
    const visible = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    window.addEventListener("remediation-notifications-changed", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("remediation-notifications-changed", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  const counts = useMemo(() => ({
    all: items.length,
    action: items.filter((item) => isActionRequired(kind, item.workflow_status)).length,
    waiting: items.filter((item) => isWaiting(kind, item.workflow_status)).length,
    completed: items.filter((item) => item.workflow_status === "COMMISSIONER_ACCEPTED").length,
  }), [items, kind]);

  const visibleItems = useMemo(() => items.filter((item) => {
    if (modeFilter !== "all" && item.detection_mode !== modeFilter) return false;
    if (filter === "all") return true;
    if (filter === "action") return isActionRequired(kind, item.workflow_status);
    if (filter === "waiting") return isWaiting(kind, item.workflow_status);
    return item.workflow_status === "COMMISSIONER_ACCEPTED";
  }), [items, filter, kind, modeFilter]);

  const openWorkflow = (item: WorkflowDashboardItem) => {
    const query = new URLSearchParams({
      workflowVerification: item.verification_id,
      locateFeature: item.feature_id,
      focusMode: "isolate",
    });
    navigate(`/map?${query.toString()}`);
  };

  const title = kind === "tasks" ? t("workflow.tasksTitle") : t("workflow.activityTitle");
  const subtitle = kind === "tasks"
    ? t("workflow.tasksSubtitle")
    : t("workflow.activitySubtitle");

  return (
    <main className="workflow-dashboard" data-testid={`${kind}-page`}>
      <header className="workflow-dashboard__header">
        <div>
          <span className="workflow-dashboard__eyebrow">
            {kind === "tasks" ? "AE · Assistant Engineer" : "AEE · Assistant Executive Engineer"}
          </span>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <button
          type="button"
          className="workflow-dashboard__refresh"
          onClick={() => void load(true)}
          disabled={refreshing}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M20 6v5h-5" />
            <path d="M4 18v-5h5" />
            <path d="M18.5 9A7 7 0 0 0 6 6.5L4 8M5.5 15A7 7 0 0 0 18 17.5l2-1.5" />
          </svg>
          {refreshing ? t("workflow.refreshing") : t("workflow.refresh")}
        </button>
      </header>

      <section className="workflow-dashboard__metrics" aria-label="Workflow summary">
        <button type="button" className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>
          <span>{t("workflow.all")}</span><strong>{counts.all}</strong>
        </button>
        <button type="button" className={filter === "action" ? "is-active" : ""} onClick={() => setFilter("action")}>
          <span>{t("workflow.actionRequired")}</span><strong>{counts.action}</strong>
        </button>
        <button type="button" className={filter === "waiting" ? "is-active" : ""} onClick={() => setFilter("waiting")}>
          <span>{t("workflow.waitingTrail")}</span><strong>{counts.waiting}</strong>
        </button>
        <button type="button" className={filter === "completed" ? "is-active" : ""} onClick={() => setFilter("completed")}>
          <span>{t("workflow.completed")}</span><strong>{counts.completed}</strong>
        </button>
      </section>

      <section className="workflow-dashboard__mode-filter" aria-label="Filter by detection type">
        <label htmlFor={`${kind}-detection-mode-filter`}>Detection type</label>
        <select
          id={`${kind}-detection-mode-filter`}
          value={modeFilter}
          onChange={(event) => setModeFilter(event.target.value as DetectionModeFilter)}
        >
          <option value="all">All detection types</option>
          {DETECTION_MODE_OPTIONS.map((mode) => (
            <option key={mode} value={mode}>{DETECTION_MODE_LABEL[mode]}</option>
          ))}
        </select>
      </section>

      {error && (
        <div className="workflow-dashboard__error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>{t("workflow.tryAgain")}</button>
        </div>
      )}

      {loading ? (
        <div className="workflow-dashboard__loading" aria-live="polite">
          <span className="workflow-dashboard__spinner" /> {t("workflow.loading")}
        </div>
      ) : visibleItems.length === 0 ? (
        <EmptyState kind={kind} t={t} />
      ) : (
        <section className="workflow-dashboard__grid" aria-label={`${title} list`}>
          {visibleItems.map((item, index) => {
            const meta = STATUS_META[item.workflow_status];
            const coordinatesAvailable = item.latitude !== null && item.longitude !== null;
            const latestTime = item.updated_at ?? item.commissioner_decided_at ?? item.aee_decided_at ?? item.submitted_at;
            return (
              <article key={item.verification_id} className="workflow-card">
                <div className="workflow-card__topline">
                  <span className="workflow-card__serial">#{String(index + 1).padStart(3, "0")}</span>
                  <span className={`workflow-card__status workflow-card__status--${meta.tone}`}>{t(meta.key)}</span>
                </div>

                <div className="workflow-card__heading">
                  <div>
                    <span className="workflow-card__mode">{item.detection_mode ? DETECTION_MODE_LABEL[item.detection_mode] : "AI issue"}</span>
                    <h2>{item.label || item.asset_type || "GIS feature"}</h2>
                    <p>{item.dataset_name}</p>
                  </div>
                  {item.ai_color && <span className={`workflow-card__ai workflow-card__ai--${item.ai_color}`}>{item.ai_color}</span>}
                </div>

                <dl className="workflow-card__details">
                  <div><dt>{t("workflow.asset")}</dt><dd>{item.asset_type || "—"}</dd></div>
                  <div><dt>{t("workflow.sourceLayer")}</dt><dd>{item.source_layer || "—"}</dd></div>
                  <div><dt>AE</dt><dd>{item.ae_name || t("workflow.notSubmitted")}</dd></div>
                  {kind === "activity" && <div><dt>AEE</dt><dd>{item.aee_name || t("workflow.notReviewed")}</dd></div>}
                  <div><dt>{t("workflow.gpsEvidence")}</dt><dd>{item.gps_validation_status === "PHOTO_EXIF_VERIFIED" ? t("workflow.verified") : t("workflow.pending")}</dd></div>
                  <div><dt>{t("workflow.updated")}</dt><dd>{formatDate(latestTime)}</dd></div>
                  <div className="workflow-card__details-wide">
                    <dt>{t("workflow.location")}</dt>
                    <dd>{coordinatesAvailable ? `${formatCoordinate(item.latitude)}, ${formatCoordinate(item.longitude)}` : t("workflow.locationUnavailable")}</dd>
                  </div>
                </dl>

                {item.issue_description && (
                  <div className="workflow-card__summary">
                    <span>{t("workflow.issue")}</span>
                    <p>{item.issue_description}</p>
                  </div>
                )}
                {item.work_completed && (
                  <div className="workflow-card__summary">
                    <span>{t("workflow.workCompleted")}</span>
                    <p>{item.work_completed}</p>
                  </div>
                )}
                {item.aee_remarks && (
                  <div className="workflow-card__summary workflow-card__summary--return">
                    <span>{t("workflow.aeeRemarks")}</span>
                    <p>{item.aee_remarks}</p>
                  </div>
                )}

                <div className="workflow-card__footer">
                  <span className="workflow-card__evidence">
                    {item.before_photo_url && item.after_photo_url ? t("workflow.evidenceAttached") : t("workflow.evidencePending")}
                  </span>
                  <button type="button" onClick={() => openWorkflow(item)}>
                    {actionLabel(kind, item, t)}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

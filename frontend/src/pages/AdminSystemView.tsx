import { Link, Navigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { apiGet } from "../lib/api";
import type { ServiceMonitoringResponse, ServiceMonitoringStatus } from "../lib/adminMonitoring";
import type { SecurityMonitoringResponse, SecurityPosture } from "../lib/adminSecurity";
import { AdminServicesOverview } from "../components/admin/services/AdminServicesOverview";
import { AdminSecurityOverview } from "../components/admin/security/AdminSecurityOverview";
import "../admin-dashboard.css";

interface ServiceProbe {
  status: "ok" | "error" | "unavailable";
  detail: string | null;
}

interface SecurityInfo {
  csrf_protection: boolean;
  rate_limit_max: number;
  rate_limit_window_seconds: number;
  failed_login_tracking: boolean;
}

interface AdminServices {
  api: ServiceProbe;
  database: ServiceProbe;
  storage: ServiceProbe;
  ai_engine: ServiceProbe;
  disk_used_percent: number | null;
  backups: ServiceProbe;
  security: SecurityInfo;
}

interface DatasetStatusCounts {
  uploaded: number;
  queued: number;
  processing: number;
  ready: number;
  failed: number;
}

interface FailedDataset {
  id: string;
  name: string;
  processing_error: string | null;
  updated_at: string;
}

interface AdminDatasets {
  counts: DatasetStatusCounts;
  recent_failures: FailedDataset[];
}

interface StuckWorkflow {
  id: string;
  feature_id: string;
  workflow_status: string;
  updated_at: string;
  hours_stuck: number;
}

interface AdminWorkflows {
  open_point_verifications: number;
  stuck_point_verifications: StuckWorkflow[];
  blocked_review_items: number;
  open_p0_review_items: number;
}

interface ActivityEntry {
  id: string;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  created_at: string;
}

interface AdminActivity {
  total_users: number;
  active_users: number;
  active_users_window_minutes: number;
  users_by_role: { role: string; count: number }[];
  recent_logins: ActivityEntry[];
  recent_events: ActivityEntry[];
}

type AdminTabId = "services" | "security" | "datasets" | "workflows" | "activity";

const WORKFLOW_LABEL_KEY: Record<string, string> = {
  AI_DETECTED: "workflow.status.aiDetected",
  WORK_IN_PROGRESS: "workflow.status.inProgress",
  PENDING_AEE_APPROVAL: "workflow.status.waitingAee",
  RETURNED_BY_AEE: "workflow.status.returned",
  AEE_APPROVED: "workflow.status.aeeApproved",
  COMMISSIONER_ACCEPTED: "workflow.status.accepted",
};

function relativeTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

function formatLastUpdated(date: Date, locale: string): string {
  const time = date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const dateStr = date.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${dateStr} · ${time}`;
}

export function AdminSystemView() {
  const { user } = useAuth();
  const { t, lang } = useLanguage();

  const [services, setServices] = useState<AdminServices | null>(null);
  const [servicesError, setServicesError] = useState(false);
  const [datasets, setDatasets] = useState<AdminDatasets | null>(null);
  const [datasetsError, setDatasetsError] = useState(false);
  const [workflows, setWorkflows] = useState<AdminWorkflows | null>(null);
  const [workflowsError, setWorkflowsError] = useState(false);
  const [activity, setActivity] = useState<AdminActivity | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [servicesNew, setServicesNew] = useState<ServiceMonitoringResponse | null>(null);
  const [security, setSecurity] = useState<SecurityMonitoringResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [activeTab, setActiveTab] = useState<AdminTabId>("services");

  useEffect(() => {
    if (user?.role !== "admin") return;
    const ctrl = new AbortController();

    const fetchOne = async <T,>(
      path: string,
      setData: (v: T) => void,
      setErr: (v: boolean) => void
    ) => {
      try {
        const data = await apiGet<T>(path, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setData(data);
      } catch (e) {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setErr(true);
      }
    };

    void Promise.allSettled([
      fetchOne<AdminServices>("/api/v1/admin/services/legacy", setServices, setServicesError),
      fetchOne<AdminDatasets>("/api/v1/admin/datasets", setDatasets, setDatasetsError),
      fetchOne<AdminWorkflows>("/api/v1/admin/workflows", setWorkflows, setWorkflowsError),
      fetchOne<AdminActivity>("/api/v1/admin/activity", setActivity, setActivityError),
    ]).then(() => {
      if (!ctrl.signal.aborted) {
        setLoaded(true);
        setLastUpdated(new Date());
      }
    });

    return () => ctrl.abort();
  }, [user?.role]);

  const overall = useMemo<{ level: "ok" | "warning" | "critical" | "checking"; label: string }>(() => {
    if (!loaded) return { level: "checking", label: t("admin.checking") };
    // Prefer the new grouped payload's overall_status when available
    if (servicesNew) {
      const s: ServiceMonitoringStatus = servicesNew.overall_status;
      if (s === "critical" || s === "offline") {
        return { level: "critical", label: t("admin.critical") };
      }
    }
    // The Security payload is the highest-priority signal once it
    // arrives — a critical posture on the Security tab means the
    // system needs attention right now, regardless of the rest.
    if (security) {
      const sp: SecurityPosture = security.overall_posture;
      if (sp === "critical") {
        return { level: "critical", label: t("admin.critical") };
      }
    }
    if (servicesError || services?.database.status === "error") {
      return { level: "critical", label: t("admin.critical") };
    }
    const warnings =
      (services && (services.ai_engine.status === "error" || services.storage.status === "error") ? 1 : 0) +
      (datasets?.counts.failed ?? 0) +
      (workflows?.stuck_point_verifications.length ?? 0) +
      (workflows?.blocked_review_items ?? 0) +
      (workflows?.open_p0_review_items ?? 0) +
      (datasetsError ? 1 : 0) +
      (workflowsError ? 1 : 0) +
      (activityError ? 1 : 0) +
      // New grouped payload: degraded/partial/unknown each count as a soft warning
      ((servicesNew?.summary.degraded ?? 0) +
        (servicesNew?.summary.partial ?? 0) +
        (servicesNew?.summary.unknown ?? 0) > 0
        ? 1
        : 0) +
      // Security: at_risk posture or any at_risk/partial controls
      (security &&
      (security.overall_posture === "at_risk" || security.overall_posture === "partially_protected")
        ? 1
        : 0) +
      ((security?.summary.critical_findings ?? 0) + (security?.summary.high_findings ?? 0) > 0 ? 1 : 0);
    if (warnings > 0) return { level: "warning", label: t("admin.attention") };
    return { level: "ok", label: t("admin.allGood") };
  }, [loaded, services, servicesError, datasets, datasetsError, workflows, workflowsError, activityError, servicesNew, security, t]);

  // Tab definitions (declaration order is the visual order in the tab row)
  const tabs: { id: AdminTabId; labelKey: string; enabled: boolean }[] = useMemo(
    () => [
      { id: "services", labelKey: "admin.services", enabled: true },
      { id: "security", labelKey: "admin.security", enabled: true },
      { id: "datasets", labelKey: "admin.datasets", enabled: true },
      { id: "workflows", labelKey: "admin.workflows", enabled: true },
      { id: "activity", labelKey: "admin.usersActivity", enabled: true },
    ],
    []
  );

  if (user?.role !== "admin") return <Navigate to="/map" replace />;

  return (
    <div className="admin-dash" data-testid="admin-system-page">
      <div className="admin-dash__inner">
        <Link to="/profile" className="profile-back" data-testid="admin-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {t("common.backToProfile")}
        </Link>

        <div className="admin-dash__header">
          <div className="admin-dash__title-row">
            <div className="admin-dash__header-text">
              <h1 className="admin-dash__title">{t("admin.title")}</h1>
              <p className="admin-dash__subtitle">{t("admin.subtitle")}</p>
            </div>

            <div className="admin-dash__header-right">
              {lastUpdated && (
                <span className="admin-last-updated" data-testid="admin-last-updated">
                  {t("admin.lastUpdated")}: {formatLastUpdated(lastUpdated, lang)}
                </span>
              )}
              <div className={`admin-overall admin-overall--${overall.level}`} data-testid="admin-overall">
                {overall.label}
              </div>
            </div>
          </div>
        </div>

        <div className="admin-tabs" role="tablist" aria-label={t("admin.title")} data-testid="admin-tabs">
              {tabs.map((tab) => {
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`admin-panel-${tab.id}`}
                    id={`admin-tab-${tab.id}`}
                    data-testid={`admin-tab-${tab.id}`}
                    disabled={!tab.enabled}
                    className={`admin-tab${active ? " admin-tab--active" : ""}${tab.enabled ? "" : " admin-tab--disabled"}`}
                    onClick={() => tab.enabled && setActiveTab(tab.id)}
                  >
                    <span className="admin-tab__label">{t(tab.labelKey)}</span>
                  </button>
                );
              })}
        </div>

        <div
          className="admin-panel"
          role="tabpanel"
          id={`admin-panel-${activeTab}`}
          aria-labelledby={`admin-tab-${activeTab}`}
          data-testid={`admin-panel-${activeTab}`}
        >
          {/* ── Services ─────────────────────────────────────── */}
          {activeTab === "services" && (
            <AdminServicesOverview
              onUpdated={(at) => setLastUpdated(at)}
              onPayload={(p) => setServicesNew(p)}
              pollMs={30_000}
            />
          )}

          {/* ── Security ─────────────────────────────────────── */}
          {activeTab === "security" && (
            <AdminSecurityOverview
              onUpdated={(at) => setLastUpdated(at)}
              onPayload={(p) => setSecurity(p)}
              pollMs={60_000}
            />
          )}

          {/* ── Datasets ─────────────────────────────────────── */}
          {activeTab === "datasets" && (
            <>
              {datasetsError && <div className="admin-empty">{t("admin.loadFailed")}</div>}
              {datasets && (
                <>
                  <div className="admin-grid">
                    <div className="admin-tile"><span className="admin-tile__label">{t("datasets.status.ready")}</span><span className="admin-tile__value">{datasets.counts.ready}</span></div>
                    <div className="admin-tile"><span className="admin-tile__label">{t("datasets.status.processing")}</span><span className="admin-tile__value">{datasets.counts.processing}</span></div>
                    <div className="admin-tile"><span className="admin-tile__label">{t("datasets.status.queued")}</span><span className="admin-tile__value">{datasets.counts.queued}</span></div>
                    <div className="admin-tile"><span className="admin-tile__label">{t("datasets.status.failed")}</span><span className="admin-tile__value">{datasets.counts.failed}</span></div>
                  </div>
                  {datasets.recent_failures.length > 0 && (
                    <ul className="admin-list">
                      {datasets.recent_failures.map((f) => (
                        <li key={f.id} className="admin-list__row">
                          <span className="admin-list__title">{f.name}</span>
                          <span className="admin-list__meta">{f.processing_error ?? "—"}</span>
                          <span className="admin-list__time">{relativeTime(f.updated_at, lang)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {datasets.recent_failures.length === 0 && (
                    <div className="admin-empty">{t("admin.noFailures")}</div>
                  )}
                </>
              )}
            </>
          )}

          {/* ── Workflows ────────────────────────────────────── */}
          {activeTab === "workflows" && (
            <>
              {workflowsError && <div className="admin-empty">{t("admin.loadFailed")}</div>}
              {workflows && (
                <>
                  <div className="admin-grid">
                    <div className="admin-tile"><span className="admin-tile__label">{t("admin.openTasks")}</span><span className="admin-tile__value">{workflows.open_point_verifications}</span></div>
                    <div className="admin-tile"><span className="admin-tile__label">{t("admin.blockedReviews")}</span><span className="admin-tile__value">{workflows.blocked_review_items}</span></div>
                    <div className="admin-tile"><span className="admin-tile__label">{t("admin.criticalReviews")}</span><span className="admin-tile__value">{workflows.open_p0_review_items}</span></div>
                  </div>
                  {workflows.stuck_point_verifications.length > 0 ? (
                    <ul className="admin-list">
                      {workflows.stuck_point_verifications.map((w) => (
                        <li key={w.id} className="admin-list__row">
                          <span className="admin-list__title">{t(WORKFLOW_LABEL_KEY[w.workflow_status] ?? w.workflow_status)}</span>
                          <span className="admin-list__meta">{t("admin.stuckFor")} {w.hours_stuck}h</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="admin-empty">{t("admin.noStuckWorkflows")}</div>
                  )}
                </>
              )}
            </>
          )}

          {/* ── Users & Activity ─────────────────────────────── */}
          {activeTab === "activity" && (
            <>
              {activityError && <div className="admin-empty">{t("admin.loadFailed")}</div>}
              {activity && (
                <>
                  <div className="admin-grid admin-grid--users">
                    <div className="admin-tile" data-testid="admin-tile-total-users">
                      <span className="admin-tile__label">{t("admin.totalUsers")}</span>
                      <span className="admin-tile__value">{activity.total_users}</span>
                      <span className="admin-tile__detail">{t("admin.totalUsersSubtitle")}</span>
                    </div>
                    <div className="admin-tile" data-testid="admin-tile-active-users">
                      <span className="admin-tile__label">{t("admin.activeUsers")}</span>
                      <span className="admin-tile__value">{activity.active_users}</span>
                      <span className="admin-tile__detail">{t("admin.activeUsersSubtitle")}</span>
                    </div>
                  </div>

                  <div className="admin-subhead">{t("admin.recentLogins")}</div>
                  {activity.recent_logins.length > 0 ? (
                    <ul className="admin-list" data-testid="admin-recent-logins">
                      {activity.recent_logins.slice(0, 5).map((e) => (
                        <li key={e.id} className="admin-list__row">
                          <span className="admin-list__title">{e.actor_name ?? "—"}</span>
                          <span className="admin-list__meta">{e.actor_role ?? ""}</span>
                          <span className="admin-list__time">{relativeTime(e.created_at, lang)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="admin-empty">{t("admin.noRecentLogins")}</div>
                  )}

                  <div className="admin-subhead">{t("admin.recentEvents")}</div>
                  {activity.recent_events.length > 0 ? (
                    <ul className="admin-list">
                      {activity.recent_events.slice(0, 5).map((e) => (
                        <li key={e.id} className="admin-list__row">
                          <span className="admin-list__title">{e.action.replace(/_/g, " ")}</span>
                          <span className="admin-list__meta">{e.actor_name ?? t("admin.system")}</span>
                          <span className="admin-list__time">{relativeTime(e.created_at, lang)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="admin-empty">{t("admin.noRecentEvents")}</div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

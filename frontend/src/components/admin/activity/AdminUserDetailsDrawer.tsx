import { useEffect, useRef, useState } from "react";
import { apiGet, ApiError } from "../../../lib/api";
import type { AdminUserActivity } from "../../../lib/adminActivity";
import {
  DEVICE_CATEGORY_LABEL,
  ORIENTATION_LABEL,
  formatAbsolute,
  formatDuration,
  formatResolution,
  relativeTime,
} from "../../../lib/adminActivity";
import { describeUserAgent } from "../../../lib/userAgent";
import { useLanguage } from "../../../context/LanguageContext";

interface AdminUserDetailsDrawerProps {
  userId: string | null;
  onClose: () => void;
}

/**
 * Right-side drawer opened by clicking a user anywhere in Admin →
 * Users & Activity (online now, recent logins, session history). Shows
 * the complete tracking record for that one user: profile, live status,
 * every session, and every logged action — the level of detail a System
 * Administrator needs to fully audit a single account.
 */
export function AdminUserDetailsDrawer({ userId, onClose }: AdminUserDetailsDrawerProps) {
  const { t, lang } = useLanguage();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [detail, setDetail] = useState<AdminUserActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Sessions are ordered newest-first by the backend — [0] is the session
  // shown at the top of Full Session History, and backs Login/Logout time
  // + Duration in Activity Summary and IP Address in Profile.
  const latestSession = detail?.sessions[0] ?? null;

  useEffect(() => {
    if (!userId) {
      setDetail(null);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    apiGet<AdminUserActivity>(`/api/v1/admin/users/${userId}/activity`, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setDetail(data);
      })
      .catch((e) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        const msg = e instanceof ApiError ? `${e.status} ${e.message}` : (e as Error).message;
        setError(msg || "Failed to load user activity");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [userId, onClose]);

  if (!userId) return null;

  return (
    <div
      className="usr-drawer__scrim"
      role="presentation"
      onClick={onClose}
      data-testid="usr-drawer-scrim"
    >
      <aside
        className="usr-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="usr-drawer-title"
        data-testid="usr-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="usr-drawer__header">
          <div className="usr-drawer__title-row">
            <h2 className="usr-drawer__title" id="usr-drawer-title">
              {detail?.user.name ?? "…"}
            </h2>
            {detail && (
              <span
                className={`usr-drawer__status usr-drawer__status--${detail.stats.is_online ? "online" : "offline"}`}
              >
                {detail.stats.is_online ? t("admin.online") : t("admin.offline")}
              </span>
            )}
          </div>
          <button
            type="button"
            className="usr-drawer__close"
            onClick={onClose}
            ref={closeRef}
            aria-label="Close details"
            data-testid="usr-drawer-close"
          >
            ×
          </button>
        </header>

        {loading && !detail && <div className="admin-empty">{t("admin.checking")}</div>}
        {error && <div className="admin-empty" role="alert">{error}</div>}

        {detail && (
          <>
            <section className="usr-drawer__section">
              <h3 className="usr-drawer__section-title">{t("admin.userProfile")}</h3>
              <dl className="usr-drawer__kv">
                <dt>{t("admin.userEmail")}</dt>
                <dd>{detail.user.email}</dd>
                <dt>{t("admin.userRole")}</dt>
                <dd>{detail.user.role}</dd>
                <dt>{t("admin.userAccountStatus")}</dt>
                <dd>{detail.user.is_active ? t("admin.userActive") : t("admin.userDisabled")}</dd>
                <dt>{t("admin.userMemberSince")}</dt>
                <dd>{formatAbsolute(detail.user.created_at, lang) ?? "—"}</dd>
                <dt>{t("admin.userIpAddress")}</dt>
                <dd>{latestSession?.ip_address ?? "—"}</dd>
              </dl>
            </section>

            <section className="usr-drawer__section">
              <h3 className="usr-drawer__section-title">{t("admin.userActivitySummary")}</h3>
              <div className="usr-drawer__stats">
                <div className="usr-drawer__stat">
                  <span className="usr-drawer__stat-value">{detail.stats.total_sessions}</span>
                  <span className="usr-drawer__stat-label">{t("admin.userTotalSessions")}</span>
                </div>
                <div className="usr-drawer__stat">
                  <span className="usr-drawer__stat-value">{detail.stats.total_logins}</span>
                  <span className="usr-drawer__stat-label">{t("admin.userTotalLogins")}</span>
                </div>
                <div className="usr-drawer__stat">
                  <span className="usr-drawer__stat-value">{detail.stats.total_events}</span>
                  <span className="usr-drawer__stat-label">{t("admin.userTotalEvents")}</span>
                </div>
              </div>
              <dl className="usr-drawer__kv">
                {detail.stats.is_online && detail.stats.current_ip && (
                  <>
                    <dt>{t("admin.userCurrentIp")}</dt>
                    <dd>{detail.stats.current_ip}</dd>
                  </>
                )}
                {detail.stats.is_online && detail.stats.current_ip && (
                  <>
                    <dt>{t("admin.userApproxLocation")}</dt>
                    <dd>{detail.stats.current_location ?? t("admin.userLocationUnknown")}</dd>
                  </>
                )}
                {detail.stats.is_online && detail.stats.current_device && (
                  <>
                    <dt>{t("admin.userCurrentDevice")}</dt>
                    <dd>{describeUserAgent(detail.stats.current_device)}</dd>
                  </>
                )}
                <dt>{t("admin.userLoginTime")}</dt>
                <dd>{latestSession ? formatAbsolute(latestSession.login_at, lang) ?? "—" : "—"}</dd>
                <dt>{t("admin.userLogoutTime")}</dt>
                <dd>
                  {latestSession
                    ? latestSession.logout_at
                      ? formatAbsolute(latestSession.logout_at, lang) ?? "—"
                      : t("admin.online")
                    : "—"}
                </dd>
                <dt>{t("admin.userSessionDuration")}</dt>
                <dd>{latestSession ? formatDuration(latestSession.duration_minutes) : "—"}</dd>
              </dl>
            </section>

            {detail.stats.is_online && detail.stats.current_device && (
              <section className="usr-drawer__section">
                <h3 className="usr-drawer__section-title">{t("admin.userDeviceDetails")}</h3>
                <dl className="usr-drawer__kv">
                  <dt>{t("admin.userDeviceCategory")}</dt>
                  <dd>
                    {detail.stats.current_device_category
                      ? DEVICE_CATEGORY_LABEL[detail.stats.current_device_category]
                      : t("admin.userLocationUnknown")}
                  </dd>
                  <dt>{t("admin.userBrowserOs")}</dt>
                  <dd>{describeUserAgent(detail.stats.current_device)}</dd>
                  <dt>{t("admin.userScreenResolution")}</dt>
                  <dd>
                    {formatResolution(detail.stats.current_screen_width, detail.stats.current_screen_height) ??
                      t("admin.userLocationUnknown")}
                  </dd>
                  {detail.stats.current_orientation && (
                    <>
                      <dt>{t("admin.userOrientation")}</dt>
                      <dd>{ORIENTATION_LABEL[detail.stats.current_orientation]}</dd>
                    </>
                  )}
                </dl>
              </section>
            )}

            <section className="usr-drawer__section">
              <h3 className="usr-drawer__section-title">{t("admin.userSessionHistory")}</h3>
              {detail.sessions.length > 0 ? (
                <ul className="usr-drawer__list">
                  {detail.sessions.map((s) => (
                    <li key={s.id} className="usr-drawer__row">
                      <span className="usr-drawer__row-main">
                        {s.is_active && <span className="admin-online-dot" aria-hidden="true" />}
                        {DEVICE_CATEGORY_LABEL[s.device_category]} · {describeUserAgent(s.user_agent)}
                      </span>
                      <span className="usr-drawer__row-meta">{s.ip_address ?? "—"}</span>
                      <span className="usr-drawer__row-meta">
                        {s.is_active ? t("admin.online") : relativeTime(s.login_at, lang)}
                      </span>
                      <span className="usr-drawer__row-time">{formatDuration(s.duration_minutes)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="admin-empty">{t("admin.noSessionHistory")}</div>
              )}
            </section>

            <section className="usr-drawer__section usr-drawer__section--last">
              <h3 className="usr-drawer__section-title">{t("admin.userEventLog")}</h3>
              {detail.events.length > 0 ? (
                <ul className="usr-drawer__list">
                  {detail.events.map((e) => (
                    <li key={e.id} className="usr-drawer__row">
                      <span className="usr-drawer__row-main">{e.action.replace(/_/g, " ")}</span>
                      <span className="usr-drawer__row-meta">{e.entity_type ?? ""}</span>
                      <span className="usr-drawer__row-meta">{e.ip_address ?? ""}</span>
                      <span className="usr-drawer__row-time">{relativeTime(e.created_at, lang)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="admin-empty">{t("admin.userNoEvents")}</div>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

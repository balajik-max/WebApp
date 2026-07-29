import { useEffect, useRef, useState } from "react";
import { apiGet, ApiError } from "../../../lib/api";
import type { SessionEntry } from "../../../lib/adminActivity";
import {
  DEVICE_CATEGORY_LABEL,
  ORIENTATION_LABEL,
  formatAbsolute,
  formatDuration,
  formatResolution,
} from "../../../lib/adminActivity";
import { describeUserAgent } from "../../../lib/userAgent";
import { useLanguage } from "../../../context/LanguageContext";

interface AdminSessionHistoryModalProps {
  open: boolean;
  onClose: () => void;
  onSelectUser: (userId: string) => void;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Full-table view of every recorded login session, opened from the
 * "Session History" heading in Admin -> Users & Activity. Unlike the
 * dashboard's inline preview (capped at the latest 15 sessions system-
 * wide), this fetches the complete history from /api/v1/admin/sessions.
 */
export function AdminSessionHistoryModal({ open, onClose, onSelectUser }: AdminSessionHistoryModalProps) {
  const { t, lang } = useLanguage();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    apiGet<{ sessions: SessionEntry[] }>("/api/v1/admin/sessions", ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setSessions(data.sessions);
      })
      .catch((e) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        const msg = e instanceof ApiError ? `${e.status} ${e.message}` : (e as Error).message;
        setError(msg || "Failed to load session history");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const rows = (sessions ?? []).map((s) => ({
    userId: s.user_id,
    user: s.user_name,
    role: s.user_role,
    ip: s.ip_address ?? "—",
    device: DEVICE_CATEGORY_LABEL[s.device_category],
    browserOs: describeUserAgent(s.user_agent),
    resolution: formatResolution(s.screen_width, s.screen_height) ?? "—",
    orientation: s.orientation ? ORIENTATION_LABEL[s.orientation] : "—",
    loginAt: formatAbsolute(s.login_at, lang) ?? "—",
    logoutAt: s.logout_at ? formatAbsolute(s.logout_at, lang) ?? "—" : t("admin.online"),
    duration: formatDuration(s.duration_minutes),
    status: s.is_active ? t("admin.online") : t("admin.offline"),
  }));

  const columns: { key: keyof (typeof rows)[number]; label: string }[] = [
    { key: "user", label: t("admin.tableUser") },
    { key: "role", label: t("admin.userRole") },
    { key: "ip", label: t("admin.userIpAddress") },
    { key: "device", label: t("admin.userDeviceCategory") },
    { key: "browserOs", label: t("admin.userBrowserOs") },
    { key: "resolution", label: t("admin.userScreenResolution") },
    { key: "orientation", label: t("admin.userOrientation") },
    { key: "loginAt", label: t("admin.userLoginTime") },
    { key: "logoutAt", label: t("admin.userLogoutTime") },
    { key: "duration", label: t("admin.userSessionDuration") },
    { key: "status", label: t("admin.tableStatus") },
  ];

  const handleExport = () => {
    downloadCsv(
      `session-history-${new Date().toISOString().slice(0, 10)}.csv`,
      columns.map((c) => c.label),
      rows.map((r) => columns.map((c) => String(r[c.key])))
    );
  };

  return (
    <div className="usr-history__scrim" role="presentation" onClick={onClose} data-testid="usr-history-scrim">
      <div
        className="usr-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby="usr-history-title"
        data-testid="usr-history-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="usr-history__header">
          <h2 className="usr-history__title" id="usr-history-title">
            {t("admin.sessionHistory")}
          </h2>
          <div className="usr-history__actions">
            <button
              type="button"
              className="usr-history__export"
              onClick={handleExport}
              disabled={rows.length === 0}
              data-testid="usr-history-export"
            >
              {t("admin.exportCsv")}
            </button>
            <button
              type="button"
              className="usr-history__close"
              onClick={onClose}
              ref={closeRef}
              aria-label="Close session history"
              data-testid="usr-history-close"
            >
              ×
            </button>
          </div>
        </header>

        <div className="usr-history__body">
          {loading && !sessions && <div className="admin-empty">{t("admin.loadingSessions")}</div>}
          {error && <div className="admin-empty" role="alert">{error}</div>}
          {!loading && !error && rows.length === 0 && (
            <div className="admin-empty">{t("admin.noSessionHistory")}</div>
          )}
          {rows.length > 0 && (
            <table className="usr-history__table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={`${r.userId}-${i}`}
                    onClick={() => onSelectUser(r.userId)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") onSelectUser(r.userId);
                    }}
                  >
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={c.key === "ip" || c.key === "browserOs" ? "usr-history__td--mute" : undefined}
                      >
                        {r[c.key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

import { Link, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { apiGet } from "../lib/api";

interface HealthResp {
  status: string;
  app: string;
  env: string;
}

interface ReadyResp {
  status: string;
  postgis: string | null;
}

interface StorageResp {
  used_percent: number;
}

type ProbeState = "checking" | "ok" | "error";

export function SystemMonitorView() {
  const { user } = useAuth();
  const { t } = useLanguage();

  const [health, setHealth] = useState<HealthResp | null>(null);
  const [healthState, setHealthState] = useState<ProbeState>("checking");
  const [dbState, setDbState] = useState<ProbeState>("checking");
  const [storage, setStorage] = useState<StorageResp | null>(null);

  useEffect(() => {
    if (user?.role !== "admin") return;
    const ctrl = new AbortController();

    void (async () => {
      const [healthRes, readyRes, storageRes] = await Promise.allSettled([
        apiGet<HealthResp>("/api/health", ctrl.signal),
        apiGet<ReadyResp>("/api/ready", ctrl.signal),
        apiGet<StorageResp>("/api/v1/system/storage", ctrl.signal),
      ]);
      if (ctrl.signal.aborted) return;

      if (healthRes.status === "fulfilled") {
        setHealth(healthRes.value);
        setHealthState("ok");
      } else {
        setHealthState("error");
      }

      setDbState(readyRes.status === "fulfilled" ? "ok" : "error");
      if (storageRes.status === "fulfilled") setStorage(storageRes.value);
    })();

    return () => ctrl.abort();
  }, [user?.role]);

  if (user?.role !== "admin") return <Navigate to="/map" replace />;

  const probeLabel = (state: ProbeState, okText: string, errText: string) =>
    state === "checking" ? t("monitor.checking") : state === "ok" ? okText : errText;

  return (
    <div className="profile-page" data-testid="monitor-page">
      <div className="profile-page__inner">
        <Link to="/profile" className="profile-back" data-testid="monitor-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {t("common.backToProfile")}
        </Link>

        <div className="profile-card">
          <div className="profile-card__header">
            <div className="profile-card__avatar" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="28" height="28">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            </div>
            <div>
              <div className="profile-card__name">{t("monitor.title")}</div>
              <div className="profile-card__role">{t("monitor.subtitle")}</div>
            </div>
          </div>

          <div className="profile-card__section">
            <div className="profile-card__section-title">{t("monitor.systemStatus")}</div>
            <dl className="profile-card__grid">
              <dt>{t("monitor.apiStatus")}</dt>
              <dd>
                <span className={`monitor-status monitor-status--${healthState === "checking" ? "pending" : healthState}`}>
                  {probeLabel(healthState, t("monitor.online"), t("monitor.offline"))}
                </span>
              </dd>

              <dt>{t("monitor.database")}</dt>
              <dd>
                <span className={`monitor-status monitor-status--${dbState === "checking" ? "pending" : dbState}`}>
                  {probeLabel(dbState, t("monitor.connected"), t("monitor.unreachable"))}
                </span>
              </dd>

              <dt>{t("monitor.storageUsed")}</dt>
              <dd>{storage ? `${storage.used_percent}% ${t("common.used")}` : t("monitor.checking")}</dd>

              <dt>{t("monitor.environment")}</dt>
              <dd>{health?.env ?? "—"}</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

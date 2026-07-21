import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { listAssignedWork, subscribeAssignedWork, type AssignedWorkRecord } from "../lib/assignedWork";

/**
 * AEE Activity dashboard.
 *
 * Visibility is enforced in two layers:
 *  1. The nav tab that links here is only rendered for AEE users
 *     (see `TabsNav` in WorkspaceLayout).
 *  2. As defence-in-depth, this route itself redirects any non-AEE user
 *     away — the Activity surface is not exposed to unauthorized roles even
 *     if they hit /activity directly.
 *
 * Shows the work items an AEE has assigned to field teams from the AI
 * Issue Remediation popup (Manhole, RED severity). Falls back to the
 * original "coming soon" placeholder until the first item is assigned.
 */
const DETECTION_KEY: Record<string, string> = {
  poles: "tasks.detection.poles",
  drains: "tasks.detection.drains",
  manholes: "tasks.detection.manhole",
};

export function ActivityView() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [records, setRecords] = useState<AssignedWorkRecord[]>([]);

  useEffect(() => {
    if (user?.role !== "aee") return;
    setRecords(listAssignedWork());
    return subscribeAssignedWork(() => setRecords(listAssignedWork()));
  }, [user?.role]);

  if (user?.role !== "aee") {
    return <Navigate to="/map" replace />;
  }

  if (records.length === 0) {
    return (
      <div className="activity-coming-soon" data-testid="activity-page">
        <div className="activity-coming-soon__inner">
          <span className="activity-coming-soon__eyebrow">{t("activity.aeeEyebrow")}</span>
          <h1>{t("nav.activity")}</h1>
          <p>{t("activity.comingSoon")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="activity-view" data-testid="activity-page">
      <header className="activity-view__header">
        <span className="activity-coming-soon__eyebrow">{t("activity.aeeEyebrow")}</span>
        <h1>{t("nav.activity")}</h1>
        <p>{records.length} {records.length === 1 ? t("tasks.item") : t("tasks.items")} {t("activity.assignedToTeams")}</p>
      </header>
      <div className="activity-view__grid">
        {records.map((record) => (
          <article key={record.id} className="activity-work-card">
            <div className="activity-work-card__header">
              <span className="activity-work-card__serial">{record.serial}</span>
              <span className="activity-work-card__mode">{t(DETECTION_KEY[record.detectionMode] ?? "tasks.detection.manhole")}</span>
            </div>
            <h2>{record.issueName}</h2>
            {record.featureLabel && <p className="activity-work-card__feature">{record.featureLabel}</p>}
            <dl className="activity-work-card__meta">
              <div><dt>{t("tasks.date")}</dt><dd>{record.date}</dd></div>
              {record.deadline && <div><dt>{t("tasks.deadline")}</dt><dd>{record.deadline}</dd></div>}
              <div><dt>{t("tasks.loc")}</dt><dd>{record.latitude.toFixed(7)}, {record.longitude.toFixed(7)}</dd></div>
              {record.road && <div><dt>{t("tasks.road")}</dt><dd>{record.road}</dd></div>}
            </dl>
            {record.remarks && <p className="activity-work-card__remarks">{record.remarks}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}

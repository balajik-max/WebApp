import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { listAssignedWork, subscribeAssignedWork, type AssignedWorkRecord } from "../lib/assignedWork";

/**
 * AE Tasks dashboard.
 *
 * Visibility is enforced in two layers:
 *  1. The nav tab that links here is only rendered for AE users
 *     (see `TabsNav` in WorkspaceLayout).
 *  2. As defence-in-depth, this route itself redirects any non-AE user
 *     away — the Tasks surface is not exposed to unauthorized roles even
 *     if they hit /tasks directly.
 *
 * Shows the work items an AEE has assigned to this AE from the AI Issue
 * Remediation popup (Manhole/Pole, RED severity). Falls back to the
 * original "coming soon" placeholder until the first item is assigned.
 */
const DETECTION_KEY: Record<string, string> = {
  poles: "tasks.detection.poles",
  drains: "tasks.detection.drains",
  manholes: "tasks.detection.manhole",
};

export function TasksView() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [records, setRecords] = useState<AssignedWorkRecord[]>([]);

  useEffect(() => {
    if (user?.role !== "ae") return;
    setRecords(listAssignedWork());
    return subscribeAssignedWork(() => setRecords(listAssignedWork()));
  }, [user?.role]);

  if (user?.role !== "ae") {
    return <Navigate to="/map" replace />;
  }

  if (records.length === 0) {
    return (
      <div className="tasks-coming-soon" data-testid="tasks-page">
        <div className="tasks-coming-soon__inner">
          <span className="tasks-coming-soon__eyebrow">{t("tasks.aeEyebrow")}</span>
          <h1>{t("nav.tasks")}</h1>
          <p>{t("tasks.comingSoon")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tasks-view" data-testid="tasks-page">
      <header className="tasks-view__header">
        <span className="tasks-coming-soon__eyebrow">{t("tasks.aeEyebrow")}</span>
        <h1>{t("nav.tasks")}</h1>
        <p>{records.length} {records.length === 1 ? t("tasks.item") : t("tasks.items")} {t("tasks.assignedToYou")}</p>
      </header>
      <div className="tasks-view__grid">
        {records.map((record) => (
          <article key={record.id} className="tasks-work-card">
            <div className="tasks-work-card__header">
              <span className="tasks-work-card__serial">{record.serial}</span>
              <span className="tasks-work-card__mode">{t(DETECTION_KEY[record.detectionMode] ?? "tasks.detection.manhole")}</span>
            </div>
            <h2>{record.issueName}</h2>
            {record.featureLabel && <p className="tasks-work-card__feature">{record.featureLabel}</p>}
            <dl className="tasks-work-card__meta">
              <div><dt>{t("tasks.date")}</dt><dd>{record.date}</dd></div>
              {record.deadline && <div><dt>{t("tasks.deadline")}</dt><dd>{record.deadline}</dd></div>}
              <div><dt>{t("tasks.loc")}</dt><dd>{record.latitude.toFixed(7)}, {record.longitude.toFixed(7)}</dd></div>
              {record.road && <div><dt>{t("tasks.road")}</dt><dd>{record.road}</dd></div>}
              {record.assignedByName && <div><dt>{t("tasks.assignedBy")}</dt><dd>{record.assignedByName}</dd></div>}
            </dl>
            {record.remarks && <p className="tasks-work-card__remarks">{record.remarks}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}

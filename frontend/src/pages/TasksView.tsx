import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "../context/AuthContext";
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
const DETECTION_LABEL: Record<string, string> = {
  poles: "Poles",
  drains: "Drains",
  manholes: "Manhole",
};

export function TasksView() {
  const { user } = useAuth();
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
          <span className="tasks-coming-soon__eyebrow">AE · Assistant Engineer</span>
          <h1>Tasks</h1>
          <p>Tasks Dashboard Coming Soon</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tasks-view" data-testid="tasks-page">
      <header className="tasks-view__header">
        <span className="tasks-coming-soon__eyebrow">AE · Assistant Engineer</span>
        <h1>Tasks</h1>
        <p>{records.length} work {records.length === 1 ? "item" : "items"} assigned to you.</p>
      </header>
      <div className="tasks-view__grid">
        {records.map((record) => (
          <article key={record.id} className="tasks-work-card">
            <div className="tasks-work-card__header">
              <span className="tasks-work-card__serial">{record.serial}</span>
              <span className="tasks-work-card__mode">{DETECTION_LABEL[record.detectionMode] ?? record.detectionMode}</span>
            </div>
            <h2>{record.issueName}</h2>
            {record.featureLabel && <p className="tasks-work-card__feature">{record.featureLabel}</p>}
            <dl className="tasks-work-card__meta">
              <div><dt>Date</dt><dd>{record.date}</dd></div>
              {record.deadline && <div><dt>Deadline</dt><dd>{record.deadline}</dd></div>}
              <div><dt>Loc</dt><dd>{record.latitude.toFixed(7)}, {record.longitude.toFixed(7)}</dd></div>
              {record.road && <div><dt>Road</dt><dd>{record.road}</dd></div>}
              {record.assignedByName && <div><dt>Assigned by</dt><dd>{record.assignedByName}</dd></div>}
            </dl>
            {record.remarks && <p className="tasks-work-card__remarks">{record.remarks}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}

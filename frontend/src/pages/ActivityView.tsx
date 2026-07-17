import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "../context/AuthContext";
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
const DETECTION_LABEL: Record<string, string> = {
  poles: "Poles",
  drains: "Drains",
  manholes: "Manhole",
};

export function ActivityView() {
  const { user } = useAuth();
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
          <span className="activity-coming-soon__eyebrow">AEE · Assistant Executive Engineer</span>
          <h1>Activity</h1>
          <p>Activity Dashboard Coming Soon</p>
        </div>
      </div>
    );
  }

  return (
    <div className="activity-view" data-testid="activity-page">
      <header className="activity-view__header">
        <span className="activity-coming-soon__eyebrow">AEE · Assistant Executive Engineer</span>
        <h1>Activity</h1>
        <p>{records.length} work {records.length === 1 ? "item" : "items"} assigned to field teams.</p>
      </header>
      <div className="activity-view__grid">
        {records.map((record) => (
          <article key={record.id} className="activity-work-card">
            <div className="activity-work-card__header">
              <span className="activity-work-card__serial">{record.serial}</span>
              <span className="activity-work-card__mode">{DETECTION_LABEL[record.detectionMode] ?? record.detectionMode}</span>
            </div>
            <h2>{record.issueName}</h2>
            {record.featureLabel && <p className="activity-work-card__feature">{record.featureLabel}</p>}
            <dl className="activity-work-card__meta">
              <div><dt>Date</dt><dd>{record.date}</dd></div>
              {record.deadline && <div><dt>Deadline</dt><dd>{record.deadline}</dd></div>}
              <div><dt>Loc</dt><dd>{record.latitude.toFixed(7)}, {record.longitude.toFixed(7)}</dd></div>
              {record.road && <div><dt>Road</dt><dd>{record.road}</dd></div>}
            </dl>
            {record.remarks && <p className="activity-work-card__remarks">{record.remarks}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}

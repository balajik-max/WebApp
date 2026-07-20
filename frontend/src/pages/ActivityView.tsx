import { Navigate } from "react-router-dom";

import { useAuth } from "../context/AuthContext";

/** Existing AEE activity placeholder. Remediation is self-started from AI map points. */
export function ActivityView() {
  const { user } = useAuth();
  if (user?.role !== "aee") return <Navigate to="/map" replace />;

  return (
    <div className="activity-coming-soon" data-testid="activity-page">
      <div className="activity-coming-soon__inner">
        <span className="activity-coming-soon__eyebrow">AEE · Assistant Executive Engineer</span>
        <h1>Activity</h1>
        <p>Activity Dashboard Coming Soon</p>
        <small>Open a Red or Yellow AI point on the map to start field remediation.</small>
      </div>
    </div>
  );
}

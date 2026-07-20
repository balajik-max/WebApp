import { Navigate } from "react-router-dom";

import { useAuth } from "../context/AuthContext";

/** Existing AE tasks placeholder. Remediation is self-started from AI map points. */
export function TasksView() {
  const { user } = useAuth();
  if (user?.role !== "ae") return <Navigate to="/map" replace />;

  return (
    <div className="tasks-coming-soon" data-testid="tasks-page">
      <div className="tasks-coming-soon__inner">
        <span className="tasks-coming-soon__eyebrow">AE · Assistant Engineer</span>
        <h1>Tasks</h1>
        <p>Tasks Dashboard Coming Soon</p>
        <small>Open a Red or Yellow AI point on the map to start field remediation.</small>
      </div>
    </div>
  );
}

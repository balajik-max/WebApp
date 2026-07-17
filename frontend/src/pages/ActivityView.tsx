import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/**
 * Placeholder for the upcoming AEE Activity dashboard.
 *
 * Visibility is enforced in two layers:
 *  1. The nav tab that links here is only rendered for AEE users
 *     (see `TabsNav` in WorkspaceLayout).
 *  2. As defence-in-depth, this route itself redirects any non-AEE user
 *     away — the Activity surface is not exposed to unauthorized roles even
 *     if they hit /activity directly.
 */
export function ActivityView() {
  const { user } = useAuth();

  if (user?.role !== "aee") {
    return <Navigate to="/map" replace />;
  }

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

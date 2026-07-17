import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/**
 * Placeholder for the upcoming AE Tasks dashboard.
 *
 * Visibility is enforced in two layers:
 *  1. The nav tab that links here is only rendered for AE users
 *     (see `TabsNav` in WorkspaceLayout).
 *  2. As defence-in-depth, this route itself redirects any non-AE user
 *     away — the Tasks surface is not exposed to unauthorized roles even
 *     if they hit /tasks directly.
 */
export function TasksView() {
  const { user } = useAuth();

  if (user?.role !== "ae") {
    return <Navigate to="/map" replace />;
  }

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

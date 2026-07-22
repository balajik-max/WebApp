import { Navigate } from "react-router-dom";

import { WorkflowDashboard } from "../components/WorkflowDashboard";
import { useAuth } from "../context/AuthContext";

export function ActivityView() {
  const { user } = useAuth();
  if (user?.role !== "aee") return <Navigate to="/map" replace />;
  return <WorkflowDashboard kind="activity" />;
}

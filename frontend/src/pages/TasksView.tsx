import { Navigate } from "react-router-dom";

import { WorkflowDashboard } from "../components/WorkflowDashboard";
import { useAuth } from "../context/AuthContext";

export function TasksView() {
  const { user } = useAuth();
  if (user?.role !== "ae") return <Navigate to="/map" replace />;
  return <WorkflowDashboard kind="tasks" />;
}

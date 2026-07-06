import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function AuthShield({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="boot" data-testid="auth-loading">
        <div className="boot__spinner" />
        <div className="boot__label">restoring session…</div>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

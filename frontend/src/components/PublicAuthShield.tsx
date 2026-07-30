import { Navigate, useLocation } from "react-router-dom";
import { usePublicAuth } from "../context/PublicAuthContext";

export function PublicAuthShield({ children }: { children: React.ReactNode }) {
  const { publicUser, loading } = usePublicAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="citizen-boot" role="status" aria-live="polite">
        <span className="citizen-spinner" />
        <span>Restoring public session…</span>
      </div>
    );
  }
  if (!publicUser) {
    return <Navigate to="/public/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

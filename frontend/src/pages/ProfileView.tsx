import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  architect: "City Architect",
};

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function ProfileView() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();

  const initial = (user?.name ?? "?").trim().charAt(0).toUpperCase();
  const roleLabel = user ? (ROLE_LABELS[user.role] ?? user.role) : "…";

  return (
    <div className="profile-page" data-testid="profile-page">
      <div className="profile-page__inner">
        <Link to="/map" className="profile-back" data-testid="profile-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to Map
        </Link>

        <div className="profile-card">
          <div className="profile-card__header">
            <div className="profile-card__avatar" aria-hidden="true">{initial}</div>
            <div>
              <div className="profile-card__name">{user?.name ?? "…"}</div>
              <div className="profile-card__role">{roleLabel}</div>
            </div>
          </div>

          <div className="profile-card__section">
            <div className="profile-card__section-title">Account Details</div>
            <dl className="profile-card__grid">
              <dt>Email</dt>
              <dd data-testid="profile-email">{user?.email ?? "—"}</dd>
              <dt>Role</dt>
              <dd>{roleLabel}</dd>
              <dt>User ID</dt>
              <dd className="profile-card__mono">{user?.id ?? "—"}</dd>
              <dt>Member Since</dt>
              <dd>{formatDate(user?.created_at)}</dd>
            </dl>
          </div>

          <div className="profile-card__section">
            <div className="profile-card__section-title">Appearance</div>
            <div className="profile-card__theme-row">
              <span>Theme</span>
              <div className="profile-card__theme-toggle" role="group" aria-label="Theme">
                <button
                  type="button"
                  className={`profile-card__theme-btn${theme === "light" ? " profile-card__theme-btn--active" : ""}`}
                  onClick={() => setTheme("light")}
                  data-testid="profile-theme-light"
                >
                  ☀ Light
                </button>
                <button
                  type="button"
                  className={`profile-card__theme-btn${theme === "dark" ? " profile-card__theme-btn--active" : ""}`}
                  onClick={() => setTheme("dark")}
                  data-testid="profile-theme-dark"
                >
                  ☾ Dark
                </button>
              </div>
            </div>
          </div>

          <div className="profile-card__section profile-card__section--actions">
            <button
              type="button"
              className="profile-card__signout"
              onClick={() => void logout()}
              data-testid="profile-signout"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

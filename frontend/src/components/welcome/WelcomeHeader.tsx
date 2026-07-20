import { Link } from "react-router-dom";

/**
 * Fixed, transparent top navigation for the Welcome page.
 * Brand on the left, a permanently-available raised 3D Login button on the
 * right. Stays above the 3D canvas and remains readable over any scene.
 */
export function WelcomeHeader() {
  return (
    <header className="welcome-header">
      <Link to="/" className="welcome-brand" aria-label="Urban Intelligence home">
        <span className="welcome-brand__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
            <path
              d="M3 20h18M6 20V9l6-5 6 5v11M10 20v-5h4v5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="welcome-brand__name">Urban Intelligence</span>
      </Link>

      <Link to="/login" className="welcome-login-button" data-testid="welcome-login">
        Login
      </Link>
    </header>
  );
}

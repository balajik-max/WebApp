import { Link } from "react-router-dom";

/**
 * Placeholder account-creation page.
 *
 * The product has no real registration backend, so per the brief we do NOT
 * create fake sign-up. This page clearly states account creation is not yet
 * available and routes users to the existing Login flow. It uses only the
 * approved palette and stays accessible.
 */
export function CreateAccountView() {
  return (
    <div className="auth-page" data-testid="create-account-page">
      <div className="auth-card auth-card--narrow">
        <div className="auth-brand">
          <span className="auth-brand__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" width="26" height="26">
              <path
                d="M3 20h18M6 20V9l6-5 6 5v11M10 20v-5h4v5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="auth-brand__name">Urban Intelligence</span>
        </div>

        <h1 className="auth-title">Create Account</h1>
        <p className="auth-lead">Self-service registration is not available yet.</p>

        <div className="auth-note" role="status">
          <p>
            Account creation will be available soon. In the meantime, use the Demo credentials on
            the Login page to explore the platform, or contact your city administrator to request
            access.
          </p>
        </div>

        <div className="auth-actions">
          <Link to="/login" className="auth-submit" data-testid="create-account-login">
            Go to Login
          </Link>
          <Link to="/" className="auth-back">
            Back to Welcome
          </Link>
        </div>
      </div>
    </div>
  );
}

export default CreateAccountView;

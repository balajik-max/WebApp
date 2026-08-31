import { FormEvent, useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { PublicPageFrame } from "../components/public/PublicPageFrame";
import { usePublicAuth } from "../context/PublicAuthContext";
import { PublicApiError } from "../lib/publicPortal";

export default function PublicLogin() {
  const { publicUser, loading, login } = usePublicAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Public Login · Smart Urban Survey";
  }, []);

  if (loading) {
    return (
      <div className="citizen-boot" role="status" aria-live="polite">
        <span className="citizen-spinner" />
        <span>Checking public session…</span>
      </div>
    );
  }
  if (publicUser) return <Navigate to="/public/dashboard" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from?.startsWith("/public/") ? from : "/public/dashboard", { replace: true });
    } catch (reason) {
      setError(
        reason instanceof PublicApiError
          ? reason.message
          : "Unable to sign in. Please check your username/email and password.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PublicPageFrame
      title="Public Login"
      description="Sign in with your public username or registered email address and password."
    >
      <section className="citizen-auth-layout" aria-label="Public login">
        <div className="citizen-auth-card">
          <div className="citizen-auth-card__heading">
            <span className="citizen-auth-icon" aria-hidden="true">👤</span>
            <div>
              <h2>Citizen Access</h2>
              <p>Officer roles and officer demo accounts are not shown here.</p>
            </div>
          </div>

          <form className="citizen-form" onSubmit={submit}>
            <label>
              <span>Username or Email Address</span>
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Enter your username or registered email"
                required
              />
            </label>

            <label>
              <span>Password</span>
              <div className="citizen-password-field">
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  required
                />
                <button type="button" onClick={() => setShowPassword((value) => !value)}>
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </label>

            {error && <div className="citizen-alert citizen-alert--error" role="alert">{error}</div>}

            <button className="citizen-primary-button" type="submit" disabled={submitting}>
              {submitting ? "Signing in…" : "Public Login"}
            </button>
          </form>

          <p className="citizen-auth-card__footer">
            New public user? <Link to="/public/register">Create an account</Link>
          </p>
        </div>

        <aside className="citizen-info-card">
          <h2>Report local problems with evidence</h2>
          <ul>
            <li>Upload or capture a geo-tagged image.</li>
            <li>Add a clear problem description and current location.</li>
            <li>Track submission and Commissioner-viewed updates.</li>
          </ul>
          <div className="citizen-separation-note">
            <strong>Separate access:</strong> AE, AEE, Commissioner, MLA and Admin continue using Officer Login.
          </div>
        </aside>
      </section>
    </PublicPageFrame>
  );
}

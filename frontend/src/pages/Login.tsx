import { Suspense, lazy, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { resolvePostLoginPath, debugAuthRedirect } from "../lib/authRedirect";
import { UrbanPlanningFallback } from "../components/auth/UrbanPlanningFallback";

// The 3D visual pulls in three.js, so it is lazy-loaded: the login form
// renders immediately and stays fully usable while the scene loads.
const UrbanPlanningVisual = lazy(() => import("../components/auth/UrbanPlanningVisual"));

interface FieldState {
  touched: boolean;
  error: string | null;
}

function validEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch {
    return false;
  }
}

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [emailState, setEmailState] = useState<FieldState>({ touched: false, error: null });
  const [pwState, setPwState] = useState<FieldState>({ touched: false, error: null });
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [webgl] = useState(isWebGLAvailable);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Single owner of post-login navigation: land on /map. We deliberately
  // ignore any preserved `location.state.from` so logging out of a page never
  // replays that route on the next login.
  useEffect(() => {
    if (user) {
      const destination = resolvePostLoginPath();
      debugAuthRedirect("post-login navigation", { destination, from: "login-effect" });
      navigate(destination, { replace: true });
    }
  }, [user, navigate]);

  function validate(): boolean {
    const e = validEmail(email) ? null : "Enter a valid email address.";
    const p = password.length >= 4 ? null : "Password must be at least 4 characters.";
    setEmailState({ touched: true, error: e });
    setPwState({ touched: true, error: p });
    return e === null && p === null;
  }

  async function submit(evt: React.FormEvent) {
    evt.preventDefault();
    setServerError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const u = await login(email.trim().toLowerCase(), password);
      void u;
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.status === 401
            ? "Invalid email or password."
            : `${err.status} — ${err.message}`
          : (err as Error).message;
      setServerError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`login-split-page ${mounted ? "login-split-page--mounted" : ""}`}
      data-testid="login-page"
    >
      <section className="login-split-page__auth">
        <div className="auth-card">
          <div className="auth-card__header">
            <h1 className="auth-title">Welcome back</h1>
            <p className="auth-lead">Sign in to continue to your workspace</p>
          </div>

          <form onSubmit={submit} className="auth-form" data-testid="login-form" noValidate>
            <div className="auth-field">
              <label className="auth-label" htmlFor="email">
                Email address
              </label>
              <input
                id="email"
                data-testid="input-email"
                type="email"
                autoComplete="email"
                placeholder="admin@davangere.gov.in"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() =>
                  setEmailState({
                    touched: true,
                    error: validEmail(email) ? null : "Enter a valid email address.",
                  })
                }
                disabled={busy}
                className={`auth-input ${emailState.touched ? (emailState.error ? "auth-input--error" : "auth-input--success") : ""}`}
                aria-invalid={!!emailState.error}
              />
              {emailState.touched && emailState.error && (
                <span className="auth-error" data-testid="err-email">{emailState.error}</span>
              )}
            </div>

            <div className="auth-field">
              <label className="auth-label" htmlFor="password">
                Password
              </label>
              <div className="auth-password-wrap">
                <input
                  id="password"
                  data-testid="input-password"
                  type={showPw ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={() =>
                    setPwState({
                      touched: true,
                      error: password.length >= 4 ? null : "Password must be at least 4 characters.",
                    })
                  }
                  disabled={busy}
                  className={`auth-input ${pwState.touched ? (pwState.error ? "auth-input--error" : "auth-input--success") : ""}`}
                  aria-invalid={!!pwState.error}
                />
                <button
                  type="button"
                  className="auth-eye-btn"
                  onClick={() => setShowPw((v) => !v)}
                  data-testid="toggle-password-visibility"
                  aria-label={showPw ? "Hide password" : "Show password"}
                  aria-pressed={showPw}
                >
                  {showPw ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
                      <path d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
                      <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </div>
              {pwState.touched && pwState.error && (
                <span className="auth-error" data-testid="err-password">{pwState.error}</span>
              )}
            </div>

            {serverError && (
              <div className="auth-alert" data-testid="login-error" role="alert">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                  <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {serverError}
              </div>
            )}

            <button type="submit" className="auth-submit" disabled={busy} data-testid="submit-login">
              {busy ? (
                <span className="auth-spinner-wrap">
                  <span className="auth-spinner" />
                  Signing in...
                </span>
              ) : (
                <>
                  Sign in
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                    <path d="M14 5l7 7m0 0l-7 7m7-7H3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </>
              )}
            </button>
          </form>

          <div className="auth-demo">
            <p>Demo credentials:</p>
            <div className="auth-demo-accounts">
              <button type="button" onClick={() => { setEmail("admin@davangere.gov.in"); setPassword("Admin@12345"); }}>
                <span className="auth-demo-badge auth-demo-badge--admin">DEMO</span>
                admin@davangere.gov.in
              </button>
              <button type="button" onClick={() => { setEmail("mla@davangere.gov.in"); setPassword("Mla@12345"); }}>
                <span className="auth-demo-badge auth-demo-badge--admin">MLA</span>
                mla@davangere.gov.in
              </button>
              <button type="button" onClick={() => { setEmail("commissioner@davangere.gov.in"); setPassword("Commissioner@12345"); }}>
                <span className="auth-demo-badge auth-demo-badge--commissioner">Commissioner</span>
                commissioner@davangere.gov.in
              </button>
              <button type="button" onClick={() => { setEmail("aee@davangere.gov.in"); setPassword("Aee@12345"); }}>
                <span className="auth-demo-badge auth-demo-badge--aee">AEE</span>
                aee@davangere.gov.in
              </button>
              <button type="button" onClick={() => { setEmail("ae@davangere.gov.in"); setPassword("Ae@12345"); }}>
                <span className="auth-demo-badge auth-demo-badge--ae">AE</span>
                ae@davangere.gov.in
              </button>
            </div>
          </div>

          <Link to="/" className="auth-back">
            ← Back to Welcome
          </Link>
        </div>
      </section>

      <section className="login-split-page__visual" aria-label="Urban planning visualization">
        {webgl ? (
          <Suspense
            fallback={
              <div className="urban-planning-visual__loading">Preparing urban planning view…</div>
            }
          >
            <UrbanPlanningVisual />
          </Suspense>
        ) : (
          <UrbanPlanningFallback />
        )}

        <div className="urban-planning-visual__overlay">
          <div className="urban-planning-visual__caption">
            <p className="urban-planning-visual__title">
              Plan smarter cities with connected geospatial intelligence.
            </p>
            <p className="urban-planning-visual__sub">
              Visualize infrastructure, monitor assets, and understand urban systems in one place.
            </p>
          </div>
          <ul className="urban-planning-visual__tags" aria-hidden="true">
            <li>Urban Planning</li>
            <li>Infrastructure</li>
            <li>GIS Intelligence</li>
            <li>City Systems</li>
          </ul>
        </div>
      </section>
    </div>
  );
}

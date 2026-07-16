import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { ApiError } from "../lib/api";
import { resolvePostLoginPath, debugAuthRedirect } from "../lib/authRedirect";

interface FieldState {
  touched: boolean;
  error: string | null;
}

function validEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

export function LoginPage() {
  const { user, login } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [emailState, setEmailState] = useState<FieldState>({ touched: false, error: null });
  const [pwState, setPwState] = useState<FieldState>({ touched: false, error: null });
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Single owner of post-login navigation: land on /map (or /profile only for
  // a genuine mandatory profile-completion rule). We deliberately ignore any
  // preserved `location.state.from` so logging out of a page — including
  // Profile — never replays that route on the next login.
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
      // Authentication state is committed by the context; the login-effect
      // owns the single post-login navigation to /map.
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
    <div className={`login ${mounted ? "login--mounted" : ""}`} data-testid="login-page">
      {/* Animated Background */}
      <div className="login__bg">
        <div className="login__bg-gradient" />
        <div className="login__bg-grid" />
        <div className="login__bg-orbs">
          <div className="login__orb login__orb--1" />
          <div className="login__orb login__orb--2" />
          <div className="login__orb login__orb--3" />
        </div>
      </div>

      {/* Main Content */}
      <div className="login__content">
        {/* Left Panel - Branding */}
        <div className="login__left">
          <div className="login__brand">
            <div className="login__logo">
              <svg viewBox="0 0 48 48" fill="none" width="48" height="48">
                <rect width="48" height="48" rx="12" fill="url(#logo-gradient)" />
                <path d="M14 24l6 6 14-14" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <defs>
                  <linearGradient id="logo-gradient" x1="0" y1="0" x2="48" y2="48">
                    <stop stopColor="#14b8a6" />
                    <stop offset="1" stopColor="#0d9488" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <div>
              <h1 className="login__brand-title">Davangere</h1>
              <p className="login__brand-sub">Smart Urban Survey Platform</p>
            </div>
          </div>

          <div className="login__features">
            <div className="login__feature">
              <div className="login__feature-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="20" height="20">
                  <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div>
                <h3>Secure Access</h3>
                <p>JWT-based authentication with rotating tokens</p>
              </div>
            </div>

            <div className="login__feature">
              <div className="login__feature-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="20" height="20">
                  <path d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div>
                <h3>PostGIS Spatial</h3>
                <p>Advanced geospatial queries and analysis</p>
              </div>
            </div>

            <div className="login__feature">
              <div className="login__feature-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="20" height="20">
                  <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div>
                <h3>AI Powered</h3>
                <p>Local Ollama integration for offline analysis</p>
              </div>
            </div>
          </div>

          <div className="login__footer">
            <button type="button" className="login__theme-btn" onClick={toggle}>
              {theme === "dark" ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
                  <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
                  <path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
            </button>
            <p className="login__copyright">© 2026 Davangere Municipal Corporation</p>
          </div>
        </div>

        {/* Right Panel - Form */}
        <div className="login__right">
          <div className="login__card">
            <div className="login__card-header">
              <h2 className="login__title">Welcome back</h2>
              <p className="login__lead">Sign in to continue to your workspace</p>
            </div>

            <form onSubmit={submit} className="login__form" data-testid="login-form" noValidate>
              <div className="login__field">
                <label className="login__label" htmlFor="email">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
                    <path d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
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
                  className={`login__input ${emailState.touched ? (emailState.error ? "login__input--error" : "login__input--success") : ""}`}
                  aria-invalid={!!emailState.error}
                />
                {emailState.touched && emailState.error && (
                  <span className="login__error" data-testid="err-email">{emailState.error}</span>
                )}
              </div>

              <div className="login__field">
                <label className="login__label" htmlFor="password">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
                    <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Password
                </label>
                <div className="login__password-wrap">
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
                    className={`login__input ${pwState.touched ? (pwState.error ? "login__input--error" : "login__input--success") : ""}`}
                    aria-invalid={!!pwState.error}
                  />
                  <button
                    type="button"
                    className="login__eye-btn"
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
                  <span className="login__error" data-testid="err-password">{pwState.error}</span>
                )}
              </div>

              {serverError && (
                <div className="login__alert" data-testid="login-error" role="alert">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                    <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {serverError}
                </div>
              )}

              <button
                type="submit"
                className="login__submit"
                disabled={busy}
                data-testid="submit-login"
              >
                {busy ? (
                  <span className="login__spinner-wrap">
                    <span className="login__spinner" />
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

            <div className="login__demo">
              <p>Demo credentials:</p>
              <div className="login__demo-accounts">
                <button type="button" onClick={() => { setEmail("admin@davangere.gov.in"); setPassword("Admin@12345"); }}>
                  <span className="login__demo-badge login__demo-badge--admin">Admin</span>
                  admin@davangere.gov.in
                </button>
                <button type="button" onClick={() => { setEmail("architect@davangere.gov.in"); setPassword("Architect@12345"); }}>
                  <span className="login__demo-badge login__demo-badge--architect">Architect</span>
                  architect@davangere.gov.in
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

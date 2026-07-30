import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PublicPortalHeader } from "../components/public/PublicPortalHeader";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { resolvePostLoginPath, debugAuthRedirect } from "../lib/authRedirect";
import smartCityArtwork from "../assets/smart-city-portal.png";

interface FieldState {
  touched: boolean;
  error: string | null;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function LoginGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 8V5.75A2.75 2.75 0 0 0 11.25 3H5.75A2.75 2.75 0 0 0 3 5.75v12.5A2.75 2.75 0 0 0 5.75 21h5.5A2.75 2.75 0 0 0 14 18.25V16" />
      <path d="M10 12h11m-4-4 4 4-4 4" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </svg>
  );
}

function MailGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}

function ShieldGlyph() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M24 5 39 11v11c0 10-6 17-15 21C15 39 9 32 9 22V11Z" />
      <path d="m17 24 5 5 10-11" />
    </svg>
  );
}

function HeadsetGlyph() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M10 27v-4a14 14 0 0 1 28 0v4" />
      <rect x="7" y="25" width="8" height="13" rx="3" />
      <rect x="33" y="25" width="8" height="13" rx="3" />
      <path d="M37 38c-2 4-6 5-11 5h-3" />
    </svg>
  );
}

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const passwordChanged = searchParams.get("passwordChanged") === "1";

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
    // The application never restores or prefills a login password.
    setPassword("");
    setShowPw(false);
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
    const emailError = validEmail(email) ? null : "Enter a valid email address.";
    const passwordError = password.length >= 4 ? null : "Password must be at least 4 characters.";
    setEmailState({ touched: true, error: emailError });
    setPwState({ touched: true, error: passwordError });
    return emailError === null && passwordError === null;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setServerError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const loggedInUser = await login(email.trim().toLowerCase(), password);
      void loggedInUser;
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.status === 401
            ? "Invalid email or password."
            : `${error.status} — ${error.message}`
          : (error as Error).message;
      setServerError(message);
    } finally {
      setBusy(false);
    }
  }

  function selectDemoAccount(demoEmail: string) {
    setEmail(demoEmail);
    setPassword("");
    setEmailState({ touched: false, error: null });
    setPwState({ touched: false, error: null });
    setServerError(null);
  }

  return (
    <div
      className={`login-split-page ${mounted ? "login-split-page--mounted" : ""}`}
      data-testid="login-page"
    >
      <PublicPortalHeader />

      <main className="login-portal-body">
        <section className="login-portal-auth" aria-labelledby="login-title">
          <div className="auth-card">
            <div className="auth-card__header">
              <span className="auth-card__lock"><LockGlyph /></span>
              <h1 className="auth-title" id="login-title">Welcome Back</h1>
              <p className="auth-lead">Sign in to continue to your workspace</p>
            </div>

            <form onSubmit={submit} className="auth-form" data-testid="login-form" noValidate autoComplete="off">
              <div className="auth-field">
                <label className="auth-label" htmlFor="email">Email address</label>
                <div className="auth-input-shell">
                  <span className="auth-input-shell__icon"><MailGlyph /></span>
                  <input
                    id="email"
                    data-testid="input-email"
                    type="email"
                    autoComplete="email"
                    placeholder="admin@davangere.gov.in"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    onBlur={() =>
                      setEmailState({
                        touched: true,
                        error: validEmail(email) ? null : "Enter a valid email address.",
                      })
                    }
                    disabled={busy}
                    className={`auth-input ${emailState.touched ? (emailState.error ? "auth-input--error" : "auth-input--success") : ""}`}
                    aria-invalid={!!emailState.error}
                    aria-describedby={emailState.error ? "email-error" : undefined}
                  />
                </div>
                {emailState.touched && emailState.error && (
                  <span className="auth-error" id="email-error" data-testid="err-email">{emailState.error}</span>
                )}
              </div>

              <div className="auth-field">
                <label className="auth-label" htmlFor="password">Password</label>
                <div className="auth-input-shell auth-password-wrap">
                  <span className="auth-input-shell__icon"><LockGlyph /></span>
                  <input
                    id="password"
                    data-testid="input-password"
                    type={showPw ? "text" : "password"}
                    autoComplete="off"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onBlur={() =>
                      setPwState({
                        touched: true,
                        error: password.length >= 4 ? null : "Password must be at least 4 characters.",
                      })
                    }
                    disabled={busy}
                    className={`auth-input ${pwState.touched ? (pwState.error ? "auth-input--error" : "auth-input--success") : ""}`}
                    aria-invalid={!!pwState.error}
                    aria-describedby={pwState.error ? "password-error" : undefined}
                  />
                  <button
                    type="button"
                    className="auth-eye-btn"
                    onClick={() => setShowPw((visible) => !visible)}
                    data-testid="toggle-password-visibility"
                    aria-label={showPw ? "Hide password" : "Show password"}
                    aria-pressed={showPw}
                  >
                    {showPw ? (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.5 10.5 0 0 1 12 5c4.5 0 8.3 2.9 9.5 7a10.5 10.5 0 0 1-2.2 3.8M6.6 6.6A10 10 0 0 0 2.5 12c1.2 4.1 5 7 9.5 7 1 0 2-.1 2.9-.4" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M2.5 12C3.7 7.9 7.5 5 12 5s8.3 2.9 9.5 7c-1.2 4.1-5 7-9.5 7S3.7 16.1 2.5 12Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
                {pwState.touched && pwState.error && (
                  <span className="auth-error" id="password-error" data-testid="err-password">{pwState.error}</span>
                )}
              </div>

              {passwordChanged && (
                <div className="auth-alert auth-alert--success" data-testid="password-changed-message" role="status">
                  Password changed successfully. Sign in using your new password.
                </div>
              )}

              {serverError && (
                <div className="auth-alert" data-testid="login-error" role="alert">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v6M12 17h.01" />
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
                    <LoginGlyph />
                    <span>Sign In</span>
                  </>
                )}
              </button>
            </form>

            <div className="auth-divider" aria-hidden="true"><span>or</span></div>

            <div className="auth-demo">
              <h2>Demo Accounts</h2>
              <p>Use any demo account below to explore the platform</p>
              <div className="auth-demo-accounts">
                <button type="button" onClick={() => selectDemoAccount("admin@davangere.gov.in")}>
                  <span className="auth-demo-badge auth-demo-badge--admin">ADMIN</span>
                  <span>admin@davangere.gov.in</span>
                </button>
                <button type="button" onClick={() => selectDemoAccount("commissioner@davangere.gov.in")}>
                  <span className="auth-demo-badge auth-demo-badge--commissioner">Commissioner</span>
                  <span>commissioner@davangere.gov.in</span>
                </button>
                <button type="button" onClick={() => selectDemoAccount("aee@davangere.gov.in")}>
                  <span className="auth-demo-badge auth-demo-badge--aee">AEE</span>
                  <span>aee@davangere.gov.in</span>
                </button>
                <button type="button" onClick={() => selectDemoAccount("ae@davangere.gov.in")}>
                  <span className="auth-demo-badge auth-demo-badge--ae">AE</span>
                  <span>ae@davangere.gov.in</span>
                </button>
                <button type="button" onClick={() => selectDemoAccount("mla@davangere.gov.in")}>
                  <span className="auth-demo-badge auth-demo-badge--mla">MLA</span>
                  <span>mla@davangere.gov.in</span>
                </button>
              </div>
            </div>

            <Link to="/" className="auth-back">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6M9 12h11" /></svg>
              <span>Back to Home</span>
            </Link>
          </div>
        </section>

        <section className="login-portal-visual" aria-label="Smart city platform overview">
          <img src={smartCityArtwork} alt="" aria-hidden="true" />
          <div className="login-portal-visual__copy">
            <h2>Smarter Decisions.<br />Stronger Cities.</h2>
            <p>
              An integrated platform for urban survey,<br />
              infrastructure monitoring, and work-progress<br />
              management — enabling connected governance<br />
              and better outcomes for every citizen.
            </p>
          </div>
        </section>
      </main>

      <footer className="login-assurance-strip">
        <div className="login-assurance-strip__inner">
          <div className="login-assurance-item">
            <span className="login-assurance-icon"><ShieldGlyph /></span>
            <span>
              <strong>Secure. Reliable. Government Approved.</strong>
              <small>Your data is protected with enterprise-grade security and privacy.</small>
            </span>
          </div>
          <div className="login-assurance-divider" aria-hidden="true" />
          <div className="login-assurance-item">
            <span className="login-assurance-icon"><HeadsetGlyph /></span>
            <span>
              <strong>Need Help?</strong>
              <small>Contact support@davanagere.gov.in</small>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

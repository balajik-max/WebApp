import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { ApiError } from "../lib/api";

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
  const location = useLocation() as { state?: { from?: string } };

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [emailState, setEmailState] = useState<FieldState>({ touched: false, error: null });
  const [pwState, setPwState] = useState<FieldState>({ touched: false, error: null });
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // If already logged in, bounce straight to the map.
  useEffect(() => {
    if (user) {
      const target = location.state?.from ?? "/";
      navigate(target, { replace: true });
    }
  }, [user, navigate, location.state?.from]);

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
      const target = location.state?.from ?? "/";
      navigate(target, { replace: true });
      // touch the reference so the linter doesn't complain about the destructured value
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
    <div className="login" data-testid="login-page">
      <div className="login__panel">
        <header className="login__brand">
          <span className="workspace__mark" />
          <div>
            <div className="login__brand-title">Davangere</div>
            <div className="login__brand-sub">Smart Urban Survey & Architecture</div>
          </div>
          <button
            type="button"
            className="login__theme"
            onClick={toggle}
            data-testid="login-theme-toggle"
            aria-label="Toggle theme"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </header>

        <div className="login__intro">
          <h1 className="login__title">Sign in to the workspace</h1>
          <p className="login__lead">
            City surveyors and architects only. Sessions are secured with signed cookies
            and rotated automatically. Your credentials never leave this deployment.
          </p>
        </div>

        <form onSubmit={submit} className="login__form" data-testid="login-form" noValidate>
          <label className="field" data-testid="field-email">
            <span className="field__label">Email</span>
            <input
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
              className={
                emailState.touched
                  ? emailState.error
                    ? "field__input field__input--err"
                    : "field__input field__input--ok"
                  : "field__input"
              }
              aria-invalid={!!emailState.error}
            />
            {emailState.touched && emailState.error && (
              <span className="field__err" data-testid="err-email">
                {emailState.error}
              </span>
            )}
          </label>

          <label className="field" data-testid="field-password">
            <span className="field__label">Password</span>
            <div className="field__with-btn">
              <input
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
                className={
                  pwState.touched
                    ? pwState.error
                      ? "field__input field__input--err"
                      : "field__input field__input--ok"
                    : "field__input"
                }
                aria-invalid={!!pwState.error}
              />
              <button
                type="button"
                className="field__peek"
                onClick={() => setShowPw((v) => !v)}
                data-testid="toggle-password-visibility"
                aria-label={showPw ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {showPw ? "hide" : "show"}
              </button>
            </div>
            {pwState.touched && pwState.error && (
              <span className="field__err" data-testid="err-password">
                {pwState.error}
              </span>
            )}
          </label>

          {serverError && (
            <div className="login__error" data-testid="login-error" role="alert">
              {serverError}
            </div>
          )}

          <button
            type="submit"
            className="login__submit"
            disabled={busy}
            data-testid="submit-login"
          >
            {busy ? "signing in…" : "Sign in"}
          </button>
        </form>

        <footer className="login__footer">
          <div className="login__hint">
            Seeded roles on this deployment:
            <ul>
              <li>
                <b>admin@davangere.gov.in</b> · Admin
              </li>
              <li>
                <b>architect@davangere.gov.in</b> · Architect
              </li>
            </ul>
          </div>
        </footer>
      </div>

      <aside className="login__poster" aria-hidden="true">
        <div className="login__poster-grid" />
        <div className="login__poster-copy">
          <div className="login__poster-eyebrow">Backend-first · Grounded AI · Fully offline</div>
          <h2 className="login__poster-title">
            Every claim<br />mapped to a row.
          </h2>
          <p className="login__poster-lead">
            PostGIS spatial index, MinIO object storage, and a local Llama 3 assistant
            that never leaves your infrastructure.
          </p>
        </div>
      </aside>
    </div>
  );
}

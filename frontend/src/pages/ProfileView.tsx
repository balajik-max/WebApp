import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { useLanguage } from "../context/LanguageContext";
import { ApiError } from "../lib/api";

const ROLE_KEY: Record<string, string> = {
  commissioner: "common.commissioner",
  aee: "common.aee",
  ae: "common.ae",
  mla: "common.mla",
  admin: "common.admin",
  architect: "common.architect",
};

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function errorDetail(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { detail?: unknown } | null;
    if (typeof body?.detail === "string") return body.detail;
  }
  return error instanceof Error ? error.message : "Unable to change password. Please try again.";
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  return hidden ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" width="18" height="18" aria-hidden="true">
      <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" width="18" height="18" aria-hidden="true">
      <path d="M3 3l18 18M10.6 10.7a2 2 0 002.7 2.7M9.9 4.2A10.7 10.7 0 0112 4c4.8 0 8.8 3.1 10 8a11.8 11.8 0 01-2.3 4.1M6.6 6.6A11.2 11.2 0 002 12c1.2 4.9 5.2 8 10 8 1.4 0 2.7-.3 3.9-.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

export function ProfileView() {
  const { user, logout, changePassword } = useAuth();
  const { theme, setTheme } = useTheme();
  const { t } = useLanguage();
  const navigate = useNavigate();

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const currentPasswordInputRef = useRef<HTMLInputElement>(null);

  const initial = (user?.name ?? "?").trim().charAt(0).toUpperCase();
  const roleLabel = user ? t((ROLE_KEY[user.role] ?? "common.admin") as "common.admin") : "…";

  function resetPasswordForm() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setShowCurrent(false);
    setShowNew(false);
    setShowConfirm(false);
    setPasswordError(null);
  }

  function openPasswordDialog() {
    resetPasswordForm();
    setPasswordDialogOpen(true);
  }

  function closePasswordDialog() {
    if (passwordBusy) return;
    setPasswordDialogOpen(false);
    resetPasswordForm();
  }

  useEffect(() => {
    if (!passwordDialogOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => currentPasswordInputRef.current?.focus(), 0);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !passwordBusy) {
        setPasswordDialogOpen(false);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setShowCurrent(false);
        setShowNew(false);
        setShowConfirm(false);
        setPasswordError(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [passwordDialogOpen, passwordBusy]);

  async function submitPasswordChange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError(null);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError(t("profile.passwordAllRequired"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t("profile.passwordMismatch"));
      return;
    }

    setPasswordBusy(true);
    try {
      await changePassword({
        current_password: currentPassword,
        new_password: newPassword,
        confirm_password: confirmPassword,
      });
      setPasswordDialogOpen(false);
      resetPasswordForm();
      navigate("/login?passwordChanged=1", { replace: true });
    } catch (error) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordError(errorDetail(error));
      window.setTimeout(() => currentPasswordInputRef.current?.focus(), 0);
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div className="profile-page" data-testid="profile-page">
      <div className="profile-page__inner">
        <Link to="/map" className="profile-back" data-testid="profile-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {t("common.backToMap")}
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
            <div className="profile-card__section-title">{t("common.accountDetails")}</div>
            <dl className="profile-card__grid">
              <dt>{t("common.email")}</dt>
              <dd data-testid="profile-email">{user?.email ?? "—"}</dd>
              <dt>{t("common.role")}</dt>
              <dd>{roleLabel}</dd>
              <dt>{t("common.userId")}</dt>
              <dd className="profile-card__mono">{user?.id ?? "—"}</dd>
              <dt>{t("common.memberSince")}</dt>
              <dd>{formatDate(user?.created_at)}</dd>
            </dl>
          </div>

          <div className="profile-card__section">
            <div className="profile-card__section-title">{t("common.appearance")}</div>
            <div className="profile-card__theme-row">
              <span>{t("common.theme")}</span>
              <div className="profile-card__theme-toggle" role="group" aria-label="Theme">
                <button type="button" className={`profile-card__theme-btn${theme === "light" ? " profile-card__theme-btn--active" : ""}`} onClick={() => setTheme("light")} data-testid="profile-theme-light">
                  ☀ {t("common.light")}
                </button>
                <button type="button" className={`profile-card__theme-btn${theme === "dark" ? " profile-card__theme-btn--active" : ""}`} onClick={() => setTheme("dark")} data-testid="profile-theme-dark">
                  ☾ {t("common.dark")}
                </button>
              </div>
            </div>
          </div>

          <div className="profile-card__section profile-card__section--actions">
            <div className="profile-card__actions-stack">
              <button type="button" className="profile-card__signout" onClick={() => void logout()} data-testid="profile-signout">
                {t("common.signout")}
              </button>
              <button type="button" className="profile-password-trigger" onClick={openPasswordDialog} data-testid="open-change-password">
                {t("profile.changePassword")}
              </button>
            </div>
          </div>
        </div>

        {user?.role === "admin" && (
          <Link to="/admin/system" className="profile-monitor-btn" data-testid="profile-monitor-system">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
            {t("common.monitorSystem")}
          </Link>
        )}
      </div>

      {passwordDialogOpen && (
        <div
          className="profile-password-modal__overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePasswordDialog();
          }}
          data-testid="change-password-overlay"
        >
          <div
            className="profile-password-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="change-password-dialog-title"
            aria-describedby="change-password-dialog-description"
            data-testid="change-password-dialog"
          >
            <div className="profile-password-modal__header">
              <div>
                <h2 id="change-password-dialog-title">{t("profile.changePassword")}</h2>
                <p id="change-password-dialog-description">{t("profile.passwordPolicy")}</p>
              </div>
              <button
                type="button"
                className="profile-password-modal__close"
                onClick={closePasswordDialog}
                aria-label={t("profile.closeDialog")}
                disabled={passwordBusy}
              >
                <CloseIcon />
              </button>
            </div>

            <form className="profile-password-form profile-password-form--modal" onSubmit={submitPasswordChange} autoComplete="off" data-testid="change-password-form">
              <div className="profile-password-modal__body">
                {[
                  { id: "current-password", label: t("profile.currentPassword"), value: currentPassword, setValue: setCurrentPassword, show: showCurrent, setShow: setShowCurrent, autoComplete: "current-password", inputRef: currentPasswordInputRef },
                  { id: "new-password", label: t("profile.newPassword"), value: newPassword, setValue: setNewPassword, show: showNew, setShow: setShowNew, autoComplete: "new-password", inputRef: undefined },
                  { id: "confirm-password", label: t("profile.confirmPassword"), value: confirmPassword, setValue: setConfirmPassword, show: showConfirm, setShow: setShowConfirm, autoComplete: "new-password", inputRef: undefined },
                ].map((field) => (
                  <label className="profile-password-form__field" key={field.id} htmlFor={field.id}>
                    <span>{field.label}</span>
                    <div className="profile-password-form__input-wrap">
                      <input
                        ref={field.inputRef}
                        id={field.id}
                        data-testid={`profile-${field.id}`}
                        type={field.show ? "text" : "password"}
                        value={field.value}
                        onChange={(event) => field.setValue(event.target.value)}
                        autoComplete={field.autoComplete}
                        disabled={passwordBusy}
                        maxLength={128}
                      />
                      <button type="button" onClick={() => field.setShow((value) => !value)} aria-label={field.show ? t("profile.hidePassword") : t("profile.showPassword")} disabled={passwordBusy}>
                        <EyeIcon hidden={!field.show} />
                      </button>
                    </div>
                  </label>
                ))}

                {passwordError && <div className="profile-password-form__error" role="alert" data-testid="change-password-error">{passwordError}</div>}
              </div>

              <div className="profile-password-modal__footer">
                <button type="button" className="profile-password-modal__cancel" onClick={closePasswordDialog} disabled={passwordBusy}>
                  {t("profile.cancel")}
                </button>
                <button type="submit" className="profile-password-form__submit" disabled={passwordBusy} data-testid="change-password-submit">
                  {passwordBusy ? t("profile.changingPassword") : t("profile.changePassword")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

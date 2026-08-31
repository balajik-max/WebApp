import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { PublicPageFrame } from "../components/public/PublicPageFrame";
import { usePublicAuth } from "../context/PublicAuthContext";
import {
  checkPublicUsername,
  PublicApiError,
  registerPublicUser,
  requestPublicOtp,
  verifyPublicOtp,
} from "../lib/publicPortal";

type RegistrationStep = "details" | "verify" | "credentials";

const STEP_INDEX: Record<RegistrationStep, number> = {
  details: 0,
  verify: 1,
  credentials: 2,
};

const REGISTRATION_STEPS = [
  "Personal Details",
  "Verify Email",
  "Create Credentials",
  "Public Dashboard",
] as const;

function passwordChecks(value: string) {
  return {
    length: value.length >= 8,
    upper: /[A-Z]/.test(value),
    lower: /[a-z]/.test(value),
    number: /\d/.test(value),
    special: /[^A-Za-z0-9]/.test(value),
  };
}

export default function CreateAccountView() {
  const { publicUser, loading, setRegisteredUser } = usePublicAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<RegistrationStep>("details");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [otp, setOtp] = useState("");
  const [debugOtp, setDebugOtp] = useState<string | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [registrationToken, setRegistrationToken] = useState("");
  const [registrationTokenExpiresAt, setRegistrationTokenExpiresAt] = useState("");
  const [username, setUsername] = useState("");
  const [usernameState, setUsernameState] = useState<"idle" | "checking" | "available" | "taken">("idle");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Create Public Account · Smart Urban Survey";
  }, []);

  useEffect(() => {
    if (resendSeconds <= 0) return undefined;
    const timer = window.setInterval(() => {
      setResendSeconds((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  const checks = useMemo(() => passwordChecks(password), [password]);
  const passwordValid = Object.values(checks).every(Boolean);
  const activeStepIndex = STEP_INDEX[step];

  if (loading) {
    return (
      <div className="citizen-boot" role="status" aria-live="polite">
        <span className="citizen-spinner" />
        <span>Checking public session…</span>
      </div>
    );
  }
  if (publicUser) return <Navigate to="/public/dashboard" replace />;

  const sendOtp = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await requestPublicOtp(phone, email);
      setChallengeId(result.challenge_id);
      setMaskedEmail(result.masked_email);
      setDebugOtp(result.debug_otp);
      setResendSeconds(result.resend_after_seconds);
      setRegistrationToken("");
      setRegistrationTokenExpiresAt("");
      setOtp("");
      setStep("verify");
    } catch (reason) {
      setError(reason instanceof PublicApiError ? reason.message : "Unable to send email OTP. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const requestOtp = async (event: FormEvent) => {
    event.preventDefault();
    await sendOtp();
  };

  const verifyOtp = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (otp.length !== 6) {
      setError("Enter the complete 6-digit email OTP.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await verifyPublicOtp(challengeId, otp);
      setRegistrationToken(result.registration_token);
      setRegistrationTokenExpiresAt(result.registration_token_expires_at);
      setMaskedEmail(result.masked_email);
      setOtp("");
      setStep("credentials");
    } catch (reason) {
      setError(reason instanceof PublicApiError ? reason.message : "Unable to verify the email OTP.");
    } finally {
      setSubmitting(false);
    }
  };

  const changeContactDetails = () => {
    setStep("details");
    setChallengeId("");
    setOtp("");
    setDebugOtp(null);
    setRegistrationToken("");
    setRegistrationTokenExpiresAt("");
    setError(null);
  };

  const checkUsername = async () => {
    const candidate = username.trim();
    if (candidate.length < 4) {
      setUsernameState("idle");
      return;
    }
    setUsernameState("checking");
    try {
      const result = await checkPublicUsername(candidate);
      setUsername(result.username);
      setUsernameState(result.available ? "available" : "taken");
    } catch {
      setUsernameState("idle");
    }
  };

  const register = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!registrationToken) {
      setError("Your verified registration session is missing. Request and verify a new OTP.");
      return;
    }
    if (usernameState !== "available") {
      setError("Please choose an available username.");
      return;
    }
    if (!passwordValid) {
      setError("Password does not meet all security requirements.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Password and confirmation do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await registerPublicUser({
        challenge_id: challengeId,
        registration_token: registrationToken,
        first_name: firstName,
        last_name: lastName,
        username,
        password,
        confirm_password: confirmPassword,
        screen_width: window.screen?.width,
        screen_height: window.screen?.height,
      });
      setRegisteredUser(result.user);
      navigate("/public/dashboard", { replace: true, state: { registered: true } });
    } catch (reason) {
      setError(reason instanceof PublicApiError ? reason.message : "Unable to create the account.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PublicPageFrame
      title="Create Public Account"
      description="Verify your email first, then securely create your username and password."
    >
      <section className="citizen-register-card">
        <ol className="citizen-stepper citizen-stepper--four" aria-label="Registration steps">
          {REGISTRATION_STEPS.map((label, index) => (
            <li
              className={activeStepIndex === index ? "active" : activeStepIndex > index ? "complete" : ""}
              key={label}
            >
              <span>{index + 1}</span>{label}
            </li>
          ))}
        </ol>

        {step === "details" && (
          <form className="citizen-form citizen-form--grid" onSubmit={requestOtp}>
            <label>
              <span>First Name</span>
              <input value={firstName} onChange={(event) => setFirstName(event.target.value)} required maxLength={120} autoComplete="given-name" />
            </label>
            <label>
              <span>Last Name</span>
              <input value={lastName} onChange={(event) => setLastName(event.target.value)} required maxLength={120} autoComplete="family-name" />
            </label>
            <label>
              <span>Phone Number</span>
              <input type="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="10-digit mobile number" required autoComplete="tel" />
              <small>Saved as your contact number. The OTP is sent to your email.</small>
            </label>
            <label className="citizen-form__full">
              <span>Email Address</span>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required maxLength={320} autoComplete="email" />
              <small>A 6-digit verification code will be sent to this email address.</small>
            </label>

            <div className="citizen-consent citizen-form__full">
              <strong>Account security</strong>
              <p>
                Password fields remain locked until your email OTP is verified. Registration does not request
                GPS location; exact location is used only when submitting a complaint.
              </p>
            </div>

            {error && <div className="citizen-alert citizen-alert--error citizen-form__full" role="alert">{error}</div>}

            <div className="citizen-form__actions citizen-form__full">
              <Link className="citizen-secondary-button" to="/public/login">Already registered</Link>
              <button className="citizen-primary-button" type="submit" disabled={submitting}>
                {submitting ? "Sending email OTP…" : "Send Email OTP"}
              </button>
            </div>
          </form>
        )}

        {step === "verify" && (
          <form className="citizen-form citizen-verify-form" onSubmit={verifyOtp}>
            <div className="citizen-alert citizen-alert--success" role="status">
              Verification code sent to <strong>{maskedEmail || email}</strong>. Check the Inbox and Spam folder.
            </div>

            <label>
              <span>6-digit Email OTP</span>
              <input
                className="citizen-otp-input"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={otp}
                onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
                required
                autoComplete="one-time-code"
                autoFocus
              />
              {debugOtp && <small className="citizen-dev-otp">Development OTP: <strong>{debugOtp}</strong></small>}
            </label>

            <div className="citizen-verify-note">
              <strong>Your password is still locked</strong>
              <p>After this OTP is verified, the username and password screen will open.</p>
            </div>

            {error && <div className="citizen-alert citizen-alert--error" role="alert">{error}</div>}

            <div className="citizen-form__actions">
              <button type="button" className="citizen-secondary-button" onClick={changeContactDetails}>Change email</button>
              <button
                type="button"
                className="citizen-secondary-button"
                onClick={() => void sendOtp()}
                disabled={submitting || resendSeconds > 0}
              >
                {resendSeconds > 0 ? `Resend in ${resendSeconds}s` : "Resend OTP"}
              </button>
              <button className="citizen-primary-button" type="submit" disabled={submitting || otp.length !== 6}>
                {submitting ? "Verifying…" : "Verify Email OTP"}
              </button>
            </div>
          </form>
        )}

        {step === "credentials" && (
          <form className="citizen-form citizen-form--grid" onSubmit={register}>
            <div className="citizen-alert citizen-alert--success citizen-form__full" role="status">
              <strong>Email verified ✓</strong> {maskedEmail || email}. You may now create your login credentials.
            </div>

            <label className="citizen-form__full">
              <span>Username</span>
              <div className="citizen-availability-field">
                <input value={username} onChange={(event) => { setUsername(event.target.value.toLowerCase()); setUsernameState("idle"); }} onBlur={() => void checkUsername()} placeholder="e.g. ravi.dvg" required autoComplete="username" />
                <button type="button" onClick={() => void checkUsername()}>Check</button>
              </div>
              <small className={`citizen-availability citizen-availability--${usernameState}`}>
                {usernameState === "checking" && "Checking availability…"}
                {usernameState === "available" && "Username is available."}
                {usernameState === "taken" && "Username already exists. Choose another."}
                {usernameState === "idle" && "Use lowercase letters, numbers, dot, underscore, or hyphen."}
              </small>
            </label>

            <label>
              <span>Create Password</span>
              <div className="citizen-password-field">
                <input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
                <button type="button" onClick={() => setShowPassword((value) => !value)}>{showPassword ? "Hide" : "Show"}</button>
              </div>
            </label>
            <label>
              <span>Confirm Password</span>
              <input type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required autoComplete="new-password" />
            </label>

            <div className="citizen-password-rules citizen-form__full" aria-label="Password requirements">
              <span className={checks.length ? "ok" : ""}>8+ characters</span>
              <span className={checks.upper ? "ok" : ""}>Uppercase</span>
              <span className={checks.lower ? "ok" : ""}>Lowercase</span>
              <span className={checks.number ? "ok" : ""}>Number</span>
              <span className={checks.special ? "ok" : ""}>Special character</span>
            </div>

            {registrationTokenExpiresAt && (
              <small className="citizen-form__full citizen-registration-expiry">
                For security, finish account setup before {new Date(registrationTokenExpiresAt).toLocaleTimeString()}.
              </small>
            )}

            {error && <div className="citizen-alert citizen-alert--error citizen-form__full" role="alert">{error}</div>}

            <div className="citizen-form__actions citizen-form__full">
              <button type="button" className="citizen-secondary-button" onClick={changeContactDetails}>Start again</button>
              <button className="citizen-primary-button" type="submit" disabled={submitting}>
                {submitting ? "Creating account…" : "Create Account"}
              </button>
            </div>
          </form>
        )}
      </section>
    </PublicPageFrame>
  );
}

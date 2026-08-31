import { useEffect } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { PublicPortalHeader } from "../components/public/PublicPortalHeader";
import smartCityArtwork from "../assets/smart-city-portal.png";

type IconName =
  | "building"
  | "pin"
  | "database"
  | "alert"
  | "clipboard"
  | "chart"
  | "users"
  | "upload"
  | "search";

type FeatureCard = {
  icon: IconName;
  title: string;
  text: string;
};

const HERO_FEATURES: FeatureCard[] = [
  {
    icon: "building",
    title: "Urban Intelligence",
    text: "One platform. A clearer view of the city.",
  },
  {
    icon: "pin",
    title: "See Infrastructure Clearly",
    text: "Accurate data. Real-time visibility.",
  },
  {
    icon: "building",
    title: "Plan with Evidence",
    text: "Better insights for better planning.",
  },
  {
    icon: "search",
    title: "Track Progress. Act Faster",
    text: "Monitor work. Improve efficiency.",
  },
  {
    icon: "building",
    title: "Build Better Urban Futures",
    text: "Stronger governance. Better communities.",
  },
];

const CAPABILITIES: FeatureCard[] = [
  {
    icon: "pin",
    title: "City Survey",
    text: "Collect and manage accurate geospatial survey data.",
  },
  {
    icon: "database",
    title: "Infrastructure Monitoring",
    text: "Monitor assets and infrastructure in real time.",
  },
  {
    icon: "alert",
    title: "Issue Detection",
    text: "Detect issues early and prioritize what matters most.",
  },
  {
    icon: "clipboard",
    title: "Work Progress",
    text: "Track ongoing work and measure progress efficiently.",
  },
  {
    icon: "chart",
    title: "Analytics & Reports",
    text: "Generate insights and reports for informed decisions.",
  },
  {
    icon: "users",
    title: "Citizen Engagement",
    text: "Engage citizens and build transparency in governance.",
  },
];

const WORK_STEPS: FeatureCard[] = [
  {
    icon: "clipboard",
    title: "Collect Data",
    text: "Field teams collect survey and asset data on the ground.",
  },
  {
    icon: "upload",
    title: "Upload & Sync",
    text: "Data is uploaded and synchronized securely to the platform.",
  },
  {
    icon: "chart",
    title: "Analyze & Detect",
    text: "AI and analytics help detect issues and generate insights.",
  },
  {
    icon: "clipboard",
    title: "Track Work",
    text: "Assign tasks, track progress, and ensure quality execution.",
  },
  {
    icon: "users",
    title: "Better Outcomes",
    text: "Make data-driven decisions for better, smarter cities.",
  },
];

function UiIcon({ name }: { name: IconName }) {
  switch (name) {
    case "building":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M7 42h34M12 42V24h9v18M21 42V10h16v32M37 42V22h6v20" />
          <path d="M26 17h5M26 24h5M26 31h5M15 30h3M15 36h3M40 29h1M40 35h1" />
        </svg>
      );
    case "pin":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M24 43s14-13 14-25a14 14 0 0 0-28 0c0 12 14 25 14 25Z" />
          <circle cx="24" cy="18" r="5" />
        </svg>
      );
    case "database":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <ellipse cx="24" cy="11" rx="15" ry="6" />
          <path d="M9 11v24c0 3 7 6 15 6s15-3 15-6V11" />
          <path d="M9 23c0 3 7 6 15 6s15-3 15-6" />
        </svg>
      );
    case "alert":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M24 7 43 40H5Z" />
          <path d="M24 18v10M24 34h.01" />
        </svg>
      );
    case "clipboard":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M17 9h14l2 5h6v28H9V14h6Z" />
          <path d="M18 22h12M18 30h8M31 31l3 3 7-8" />
        </svg>
      );
    case "chart":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M8 39h32M13 39V27h6v12M22 39V19h6v20M31 39V12h6v27" />
          <path d="M14 16h13l-4-4M27 16l-4 4" />
        </svg>
      );
    case "users":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="24" cy="17" r="7" />
          <path d="M12 40c1-9 5-14 12-14s11 5 12 14" />
          <path d="M10 25a5 5 0 1 1 2-9M38 25a5 5 0 1 0-2-9M4 40c1-6 4-10 9-11M44 40c-1-6-4-10-9-11" />
        </svg>
      );
    case "upload":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M24 32V9M15 18l9-9 9 9" />
          <path d="M12 28a11 11 0 0 0 2 22h20a10 10 0 0 0 1-20" transform="translate(0 -10)" />
        </svg>
      );
    case "search":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="21" cy="21" r="12" />
          <path d="m31 31 10 10M13 23l5-5 5 4 8-10" />
        </svg>
      );
  }
}

function LoginGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 8V5.75A2.75 2.75 0 0 0 11.25 3H5.75A2.75 2.75 0 0 0 3 5.75v12.5A2.75 2.75 0 0 0 5.75 21h5.5A2.75 2.75 0 0 0 14 18.25V16" />
      <path d="M10 12h11m-4-4 4 4-4 4" />
    </svg>
  );
}

function UserPlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 19c-.9-3.2-3.2-5-6.5-5S2.9 15.8 2 19" />
      <circle cx="8.5" cy="7.5" r="3.5" />
      <path d="M18 8v8M14 12h8" />
    </svg>
  );
}

function SectionHeading({ children }: { children: string }) {
  return (
    <div className="public-welcome-section-heading">
      <h2>{children}</h2>
      <span aria-hidden="true" />
    </div>
  );
}

export default function WelcomeView() {
  const { user } = useAuth();

  useEffect(() => {
    document.body.classList.add("public-welcome-scroll");

    return () => {
      document.body.classList.remove("public-welcome-scroll");
    };
  }, []);

  if (user) {
    return <Navigate to="/map" replace />;
  }

  return (
    <div className="public-welcome-page">
      <a className="public-welcome-skip" href="#main">Skip to content</a>
      <PublicPortalHeader showLoginAction />

      <main id="main" className="public-welcome-main">
        <section className="public-welcome-hero" aria-labelledby="welcome-title">
          <div className="public-welcome-container public-welcome-hero__inner">
            <div className="public-welcome-hero__content">
              <p className="public-welcome-eyebrow">Smart Urban Survey</p>
              <h1 id="welcome-title">
                Smarter Decisions.
                <br />
                Stronger Cities.
              </h1>
              <p className="public-welcome-hero__lead">
                An integrated platform for urban survey, infrastructure monitoring, and work-progress management &mdash; enabling connected governance and better outcomes for every citizen.
              </p>

              <div className="public-welcome-feature-list" aria-label="Platform highlights">
                {HERO_FEATURES.map((feature) => (
                  <article className="public-welcome-feature-card" key={feature.title}>
                    <span className="public-welcome-feature-card__icon">
                      <UiIcon name={feature.icon} />
                    </span>
                    <span>
                      <strong>{feature.title}</strong>
                      <small>{feature.text}</small>
                    </span>
                  </article>
                ))}
              </div>

              <div className="public-welcome-actions" aria-label="Public actions">
                <Link to="/public/login" className="public-welcome-button public-welcome-button--primary">
                  <LoginGlyph />
                  <span>Public Login</span>
                </Link>
                <Link to="/public/register" className="public-welcome-button public-welcome-button--secondary">
                  <UserPlusGlyph />
                  <span>Create Account</span>
                </Link>
              </div>
            </div>

            <div className="public-welcome-hero__visual">
              <img
                src={smartCityArtwork}
                alt="Illustration of a smart urban district with buildings, roads, green spaces, and civic data markers"
              />
            </div>
          </div>
        </section>

        <section className="public-welcome-section public-welcome-capabilities" aria-labelledby="capabilities-title">
          <SectionHeading>Powerful Capabilities. One Unified Platform.</SectionHeading>
          <div id="capabilities-title" className="public-welcome-sr-only">
            Powerful Capabilities. One Unified Platform.
          </div>

          <div className="public-welcome-capability-grid">
            {CAPABILITIES.map((capability) => (
              <article className="public-welcome-capability-card" key={capability.title}>
                <span className="public-welcome-capability-card__icon">
                  <UiIcon name={capability.icon} />
                </span>
                <h3>{capability.title}</h3>
                <p>{capability.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="public-welcome-section public-welcome-workflow" aria-labelledby="workflow-title">
          <SectionHeading>How It Works</SectionHeading>
          <div id="workflow-title" className="public-welcome-sr-only">How It Works</div>

          <ol className="public-welcome-workflow-list">
            {WORK_STEPS.map((step, index) => (
              <li className="public-welcome-workflow-step" key={step.title}>
                <span className="public-welcome-workflow-step__number">{index + 1}</span>
                <span className="public-welcome-workflow-step__icon">
                  <UiIcon name={step.icon} />
                </span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="public-welcome-footer">
        <div className="public-welcome-footer__skyline" aria-hidden="true" />
        <div className="public-welcome-footer__inner">
          <div className="public-welcome-footer__brand-mark">
            <UiIcon name="building" />
          </div>
          <h2>Smart Urban Survey</h2>
          <p>Urban planning, infrastructure, and public services &mdash; connected in one intelligent platform.</p>
          <nav className="public-welcome-footer__nav" aria-label="Footer navigation">
            <a href="#main">About the Platform</a>
            <Link to="/public/login">Public Login</Link>
            <Link to="/public/register">Create Account</Link>
            <a href="mailto:support@urbansurvey.app">Contact Support</a>
          </nav>

          <div className="public-welcome-footer__lower">
            <div>
              <strong>Official platform for city governance.</strong>
              <span>Secure. Accurate. Accountable.</span>
            </div>
            <div>
              <strong>Need Help?</strong>
              <a href="mailto:support@urbansurvey.app">support@urbansurvey.app</a>
            </div>
          </div>

          <small className="public-welcome-footer__copyright">
            &copy; 2026 Government of Karnataka. All rights reserved.
          </small>
        </div>
      </footer>
    </div>
  );
}

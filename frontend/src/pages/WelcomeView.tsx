import { Suspense, lazy, useEffect, useMemo, useRef } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { WelcomeHeader } from "../components/welcome/WelcomeHeader";
import { WelcomeSection } from "../components/welcome/WelcomeSection";
import { WelcomeGetStarted } from "../components/welcome/WelcomeGetStarted";
import { ScrollProgress } from "../components/welcome/ScrollProgress";
import { usePrefersReducedMotion, useSectionReveal } from "../components/welcome/useScrollScene";
import {
  SECTIONS,
  HERO_SUBTITLE,
} from "../components/welcome/urbanSceneConfig";

// WelcomeScene pulls in three.js + all the procedural geometry, so it is
// route-level lazy-loaded: the authenticated app never pays for it, and the
// initial Welcome bundle stays small.
const WelcomeScene = lazy(() => import("../components/welcome/WelcomeScene"));

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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function BrandedLoader() {
  return (
    <div className="welcome-loader" role="status" aria-live="polite">
      <div className="welcome-loader__brand">Urban Intelligence</div>
      <div className="welcome-loader__spinner" aria-hidden="true" />
      <div className="welcome-loader__label">Loading city experience…</div>
    </div>
  );
}

export default function WelcomeView() {
  const { user } = useAuth();
  const reducedMotion = usePrefersReducedMotion();
  const webgl = useMemo(isWebGLAvailable, []);

  const progressRef = useRef(0);
  const barRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);

  // Single, shared, rAF-throttled scroll listener. It drives BOTH the camera
  // (via progressRef) and the progress bar (via barRef) so there is exactly
  // one scroll handler in the whole experience — no duplicate listeners.
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const p = max > 0 ? clamp(window.scrollY / max, 0, 1) : 0;
      progressRef.current = p;
      if (barRef.current) barRef.current.style.transform = `scaleX(${p})`;
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    update();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useSectionReveal(sectionRefs);

  // Preserve existing authenticated behaviour: / previously redirected to
  // /map. Authenticated visitors are sent straight to the app; everyone else
  // sees the Welcome walkthrough.
  if (user) {
    return <Navigate to="/map" replace />;
  }

  const storySections = SECTIONS.slice(0, 5);

  return (
    <div className={`welcome ${reducedMotion ? "welcome--reduced" : ""}`}>
      <a className="welcome-skip" href="#main">
        Skip to content
      </a>

      <WelcomeHeader />

      <ScrollProgress ref={barRef} />

      {webgl && (
        <div className="welcome-scene-wrap">
          <Suspense fallback={<BrandedLoader />}>
            <WelcomeScene reducedMotion={reducedMotion} progressRef={progressRef} />
          </Suspense>
        </div>
      )}

      <main id="main" className="welcome-main">
        <section className="welcome-hero" aria-labelledby="hero-title">
          <div className="welcome-hero__card">
            <h1 className="welcome-hero__title" id="hero-title">
              Urban Intelligence
            </h1>
            <p className="welcome-hero__subtitle">{HERO_SUBTITLE}</p>
            <p className="welcome-hero__hint" aria-hidden="true">
              Scroll to explore the city
            </p>
          </div>
        </section>

        {storySections.map((s, i) => (
          <WelcomeSection
            key={s.id}
            ref={(el) => {
              sectionRefs.current[i] = el;
            }}
            id={s.id}
            index={i + 1}
            title={s.title}
            body={s.body}
            align={i % 2 === 0 ? "left" : "right"}
          />
        ))}

        <WelcomeGetStarted />

        <footer className="welcome-footer">
          <div className="welcome-footer__brand">Urban Intelligence</div>
          <p className="welcome-footer__note">
            Urban planning, infrastructure and services — connected.
          </p>
          <nav className="welcome-footer__nav" aria-label="Footer">
            <a href="/login">Login</a>
            <a href="/create-account">Create Account</a>
          </nav>
        </footer>
      </main>
    </div>
  );
}

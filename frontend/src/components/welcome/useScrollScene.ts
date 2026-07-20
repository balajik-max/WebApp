/**
 * Scroll + motion hooks that drive the Walkthrough.
 *
 * `useScrollProgressRef` writes a NORMALIZED scroll progress (0..1) into a
 * ref on every scroll/resize, throttled with requestAnimationFrame. It never
 * triggers a React re-render, so the Three.js render loop can read it freely
 * without causing a render storm. This is the single source of scroll truth.
 *
 * `usePrefersReducedMotion` reflects the OS reduced-motion preference.
 */
import { useEffect, useRef, useState } from "react";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function useScrollProgressRef(): React.MutableRefObject<number> {
  const progress = useRef(0);

  useEffect(() => {
    let raf = 0;
    const compute = () => {
      raf = 0;
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      progress.current = max > 0 ? clamp(window.scrollY / max, 0, 1) : 0;
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(compute);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    compute();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return progress;
}

/** Returns true when the user has requested reduced motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReduced(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return reduced;
}

/**
 * Toggles an `is-visible` class on observed sections as they enter the
 * viewport, powering the fade-in reveal (used even in normal motion mode,
 * and the ONLY reveal mechanism in reduced-motion mode).
 */
export function useSectionReveal(
  refs: React.MutableRefObject<Array<HTMLElement | null>>,
): void {
  useEffect(() => {
    const nodes = refs.current.filter(Boolean) as HTMLElement[];
    if (typeof IntersectionObserver === "undefined") {
      nodes.forEach((n) => n.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          } else {
            entry.target.classList.remove("is-visible");
          }
        }
      },
      { threshold: 0.25, rootMargin: "0px 0px -10% 0px" },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

import { useEffect, useState } from "react";

// Keep in sync with the `@media (max-width: 768px)` breakpoint used
// throughout frontend/src/index.css and frontend/src/mobile.css.
export const MOBILE_BREAKPOINT_PX = 768;

const query = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    // Some automated/embedded viewport-resize paths (browser devtools
    // emulation, test harnesses) don't reliably dispatch MediaQueryList's
    // "change" event even though layout and CSS media queries do update —
    // the plain window "resize" event is dispatched more consistently, so
    // it's kept as a fallback alongside the standard matchMedia listener.
    const handleChange = () => setIsMobile(mql.matches);
    handleChange();
    mql.addEventListener("change", handleChange);
    window.addEventListener("resize", handleChange);
    return () => {
      mql.removeEventListener("change", handleChange);
      window.removeEventListener("resize", handleChange);
    };
  }, []);

  return isMobile;
}

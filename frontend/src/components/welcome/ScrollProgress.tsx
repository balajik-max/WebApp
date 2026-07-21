import { forwardRef } from "react";

/**
 * Slim scroll-progress indicator. It is purely presentational: the parent
 * (WelcomeView) owns the SINGLE scroll listener and pushes the normalized
 * progress straight onto this bar's transform via the forwarded ref, so no
 * React state churn or extra listeners are involved.
 */
export const ScrollProgress = forwardRef<HTMLDivElement>(function ScrollProgress(_props, ref) {
  return (
    <div className="welcome-progress" aria-hidden="true">
      <div className="welcome-progress__bar" ref={ref} />
    </div>
  );
});

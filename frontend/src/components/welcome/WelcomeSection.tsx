import { forwardRef } from "react";

interface WelcomeSectionProps {
  id: string;
  index: number;
  title: string;
  body: string;
  align?: "left" | "right" | "center";
}

/**
 * A single scroll story section. The visible content is plain DOM (never
 * trapped inside WebGL) so it is always accessible, crawlable, and available
 * in the reduced-motion / no-WebGL fallback. The 3D scene behind it provides
 * the accompanying visual focal point.
 */
export const WelcomeSection = forwardRef<HTMLElement, WelcomeSectionProps>(
  function WelcomeSection({ id, index, title, body, align = "left" }, ref) {
    return (
      <section
        ref={ref}
        id={id}
        className={`welcome-section welcome-section--${align}`}
        aria-labelledby={`${id}-title`}
      >
        <div className="welcome-section__card">
          <span className="welcome-section__index">{String(index).padStart(2, "0")}</span>
          <h2 className="welcome-section__title" id={`${id}-title`}>
            {title}
          </h2>
          <p className="welcome-section__body">{body}</p>
        </div>
      </section>
    );
  },
);

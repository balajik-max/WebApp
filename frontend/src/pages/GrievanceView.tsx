import { useEffect } from "react";
import { useLanguage } from "../context/LanguageContext";

const NAMMADVG_URL = "https://nammadvg.com";

/**
 * Grievance tab — mirrors the Samarth Shamanur campaign grievance page.
 * The page itself is a bridge/entry point: it presents the Kannada + English
 * "raise your concern" copy and a primary CTA that opens NammaDVG.com (the
 * actual grievance platform).
 */
export function GrievanceView() {
  const { lang } = useLanguage();
  useEffect(() => {}, []);

  return (
    <div className="grievance-page" data-testid="grievance-page">
      <div className="grievance-page__inner">
        <div className="grievance-hero">
          <span className="grievance-hero__emoji" aria-hidden="true">🤝</span>
          <h1 className="grievance-hero__kn">ನಿಮ್ಮ ಸಮಸ್ಯೆ ಏನು?</h1>
          <p className="grievance-hero__kn-sub">ನಾವು ಕೇಳಲು ಇದ್ದೇವೆ.</p>

          <h2 className="grievance-hero__en">Have a concern? We are here to listen.</h2>
          <p className="grievance-hero__en-sub">
            ನಿಮ್ಮ ಧ್ವನಿ ಮುಖ್ಯ. ನಿಮ್ಮ ದೂರುಗಳನ್ನು ಹಂಚಿಕೊಳ್ಳಿ.
            <br />
            Your voice matters. Raise your grievance and be heard.
          </p>

          <a
            className="grievance-cta"
            href={NAMMADVG_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="grievance-raise"
          >
            {lang === "kn" ? "ದೂರು ಸಲ್ಲಿಸಿ" : "Raise Your Grievance"}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
              <path d="M7 17 17 7M17 7H8M17 7v9" />
            </svg>
          </a>

          <p className="grievance-trust">ಕೆಲಸ ಕಂಡಿದ್ದೇವೆ… ನಂಬಿಕೆ ಇದೆ…<br />Seen the work. Trust the system.</p>
        </div>
      </div>
    </div>
  );
}

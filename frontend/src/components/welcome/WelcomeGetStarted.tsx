import { Link } from "react-router-dom";

/**
 * Final call-to-action of the walkthrough. Presented as a 3D plaza in the
 * scene, but the actionable controls here are plain, accessible DOM buttons
 * so keyboard and screen-reader users can always reach them.
 */
export function WelcomeGetStarted() {
  return (
    <section
      id="getstarted"
      className="welcome-section welcome-getstarted"
      aria-labelledby="getstarted-title"
    >
      <div className="welcome-getstarted__card">
        <h2 className="welcome-getstarted__title" id="getstarted-title">
          Start Exploring Your City
        </h2>
        <p className="welcome-getstarted__body">
          Access the Urban Intelligence platform to view data, monitor work, and manage urban
          systems.
        </p>
        <div className="welcome-getstarted__actions">
          <Link to="/login" className="welcome-cta welcome-cta--primary" data-testid="getstarted-login">
            Login
          </Link>
          <Link
            to="/create-account"
            className="welcome-cta welcome-cta--secondary"
            data-testid="getstarted-create"
          >
            Create Account
          </Link>
        </div>
      </div>
    </section>
  );
}

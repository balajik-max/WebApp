import { useEffect } from "react";
import { Link } from "react-router-dom";
import { PublicPortalHeader } from "./PublicPortalHeader";

export function PublicPageFrame({
  children,
  title,
  description,
  showBackToHome = true,
}: {
  children: React.ReactNode;
  title: string;
  description: string;
  showBackToHome?: boolean;
}) {
  useEffect(() => {
    document.body.classList.add("citizen-scroll");
    return () => document.body.classList.remove("citizen-scroll");
  }, []);

  return (
    <div className="citizen-page">
      <PublicPortalHeader showLoginAction />
      <main className="citizen-page__main">
        <section className="citizen-page__intro">
          {showBackToHome && (
            <Link className="citizen-back-link" to="/">
              <span aria-hidden="true">←</span> Back to Welcome
            </Link>
          )}
          <p className="citizen-eyebrow">Smart Urban Survey</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </section>
        {children}
      </main>
    </div>
  );
}

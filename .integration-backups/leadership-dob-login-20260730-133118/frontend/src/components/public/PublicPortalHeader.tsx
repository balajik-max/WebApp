import { Link } from "react-router-dom";
import cmPhoto from "../../assets/cm.jpeg";
import corporationLogo from "../../assets/davanagere-corporation-logo.png";
import deputyCmPhoto from "../../assets/deputy-cm.jpg";
import karnatakaLogo from "../../assets/government-karnataka-logo.png";
import mlaPhoto from "../../assets/mla.jpg";

type PublicPortalHeaderProps = {
  showLoginAction?: boolean;
};

function LoginGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 8V5.75A2.75 2.75 0 0 0 11.25 3H5.75A2.75 2.75 0 0 0 3 5.75v12.5A2.75 2.75 0 0 0 5.75 21h5.5A2.75 2.75 0 0 0 14 18.25V16" />
      <path d="M10 12h11m-4-4 4 4-4 4" />
    </svg>
  );
}

const OFFICIALS = [
  { label: "CM", photo: cmPhoto, alt: "CM" },
  { label: "DCM", photo: deputyCmPhoto, alt: "Deputy CM" },
  { label: "MLA", photo: mlaPhoto, alt: "MLA" },
] as const;

export function PublicPortalHeader({ showLoginAction = false }: PublicPortalHeaderProps) {
  return (
    <header className="public-portal-header">
      <div className="public-portal-header__accent" />
      <div className="public-portal-header__inner">
        <div className="public-portal-header__agencies" aria-label="Government agencies">
          <div className="portal-agency">
            <span className="portal-agency__mark portal-agency__mark--karnataka">
              <img src={karnatakaLogo} alt="Government of Karnataka" />
            </span>
            <span>Government of<br />Karnataka</span>
          </div>
          <div className="portal-agency portal-agency--corporation">
            <span className="portal-agency__mark">
              <img src={corporationLogo} alt="Davanagere City Corporation" />
            </span>
            <span>Davanagere<br />City Corporation</span>
          </div>
        </div>

        <Link to="/" className="public-portal-header__identity" aria-label="Davanagere Smart Urban Survey home">
          <span className="public-portal-header__title">Davanagere Smart Urban Survey</span>
          <span className="public-portal-header__subtitle">
            Government of Karnataka
            <i aria-hidden="true" />
            Davanagere City Corporation
          </span>
        </Link>

        <div className="public-portal-header__right">
          <div className="portal-officials" aria-label="Government leadership">
            {OFFICIALS.map((official) => (
              <div className="portal-official" key={official.label}>
                <span className="portal-official__avatar">
                  <img src={official.photo} alt={official.alt} />
                </span>
                <span>{official.label}</span>
              </div>
            ))}
          </div>

          {showLoginAction && (
            <Link to="/login" className="portal-header-login" data-testid="welcome-login">
              <LoginGlyph />
              <span>Officer Login</span>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

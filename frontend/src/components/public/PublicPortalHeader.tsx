import { Link } from "react-router-dom";
import chiefMinisterPhoto from "../../assets/chief-minister-dk-shivakumar.png";
import corporationLogo from "../../assets/davanagere-corporation-logo.png";
import urbanDevelopmentMinisterPhoto from "../../assets/urban-development-minister-yathindra-siddaramaiah.png";
import karnatakaLogo from "../../assets/government-karnataka-logo.png";
import commissionerPhoto from "../../assets/Dr. N. Mahantesh.jpg";

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
  {
    name: "Shri. D.K. Shivakumar",
    designation: "Hon'ble Chief Minister",
    photo: chiefMinisterPhoto,
    alt: "Shri D.K. Shivakumar, Hon'ble Chief Minister of Karnataka",
  },
  {
    name: "Shri Yathindra Siddaramaiah",
    designation: "Minister for Urban Development",
    photo: urbanDevelopmentMinisterPhoto,
    alt: "Shri Yathindra Siddaramaiah, Minister for Urban Development, Government of Karnataka",
  },
  {
    name: "Dr. N. Mahantesh",
    designation: "Commissioner, Davanagere City Corporation",
    photo: commissionerPhoto,
    alt: "Dr. N. Mahantesh, KMAS (Selection Grade), Commissioner, Davanagere City Corporation",
  },
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
              <div className="portal-official" key={official.name}>
                <span className="portal-official__avatar">
                  <img src={official.photo} alt={official.alt} />
                </span>
                <span className="portal-official__name">{official.name}</span>
                <span className="portal-official__designation">{official.designation}</span>
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

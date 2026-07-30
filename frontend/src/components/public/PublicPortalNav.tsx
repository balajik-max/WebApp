import { NavLink } from "react-router-dom";

function HomeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11.2 12 4l8.5 7.2" /><path d="M5.5 10.2V20h13v-9.8M9.5 20v-6h5v6" /></svg>;
}

function MapIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z" /><path d="M9 3v15m6-12v15" /></svg>;
}

function DatasetIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="7.5" ry="3" /><path d="M4.5 5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5" /><path d="M4.5 11v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" /></svg>;
}

const LINKS = [
  { to: "/public/dashboard", label: "Home", icon: <HomeIcon /> },
  { to: "/public/map", label: "Map", icon: <MapIcon /> },
  { to: "/public/datasets", label: "Datasets", icon: <DatasetIcon /> },
] as const;

export function PublicPortalNav() {
  return (
    <nav className="public-portal-nav" aria-label="Public portal navigation">
      <div className="public-portal-nav__inner">
        {LINKS.map((link) => (
          <NavLink
            className={({ isActive }) => `public-portal-nav__link${isActive ? " active" : ""}`}
            key={link.to}
            to={link.to}
          >
            {link.icon}
            <span>{link.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

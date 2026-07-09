import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import type { FeatureFilter } from "../lib/types";
import { fetchCategories, fetchWards, type CategoryOption, type WardOption, type DatasetRow } from "../lib/workflow";

/**
 * WorkspaceLayout — the shell that hosts the three tab views.
 *
 * Filters AND the selected-dataset(s) live at this level, not inside the
 * map tab, so switching tabs preserves them — the map/datasets/analytics
 * routes are unmounted and remounted by the router on every tab switch,
 * so any state that lived inside one of those pages was getting wiped
 * out the moment you left it.
 */
export function WorkspaceLayout() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const location = useLocation();

  const [ward, setWard] = useState("");
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState("");
  const [filter, setFilter] = useState<FeatureFilter>({});
  const [wardOptions, setWardOptions] = useState<WardOption[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[]>([]);
  const [selectedDatasets, setSelectedDatasets] = useState<DatasetRow[]>([]);

  const showFilters = location.pathname.startsWith("/map");

  useEffect(() => {
    if (!showFilters) return;
    const ctrl = new AbortController();
    fetchWards(ctrl.signal)
      .then(setWardOptions)
      .catch(() => {
        /* filter still works without the dropdown populated */
      });
    return () => ctrl.abort();
  }, [showFilters]);

  useEffect(() => {
    if (!showFilters) return;
    const ctrl = new AbortController();
    fetchCategories(ward || undefined, ctrl.signal)
      .then(setCategoryOptions)
      .catch(() => {});
    return () => ctrl.abort();
  }, [showFilters, ward]);

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    const next: FeatureFilter = {};
    if (ward.trim()) next.ward = ward.trim();
    if (category.trim()) next.category = category.trim();
    if (severity.trim() && !Number.isNaN(Number(severity))) next.severity = Number(severity);
    setFilter(next);
  }

  function resetFilters() {
    setWard("");
    setCategory("");
    setSeverity("");
    setFilter({});
  }

  const outletContext = useMemo(
    () => ({ filter, selectedDatasets, setSelectedDatasets }),
    [filter, selectedDatasets]
  );

  return (
    <div className="workspace" data-testid="workspace">
      <header className="workspace__topbar" data-testid="topbar">
        <div className="workspace__brand">
          <span className="workspace__mark" />
          <div>
            <div className="workspace__title">Davangere Urban Survey</div>
            <div className="workspace__subtitle" data-testid="topbar-user">
              signed in as <b>{user?.name ?? "…"}</b> · {user?.role ?? "…"}
            </div>
          </div>
        </div>

        <nav className="tabs" data-testid="tabs">
          <NavLink to="/map" data-testid="tab-map">
            Map
          </NavLink>
          <NavLink to="/datasets" data-testid="tab-datasets">
            Datasets
          </NavLink>
          <NavLink to="/analytics" data-testid="tab-analytics">
            Analytics
          </NavLink>
        </nav>

        <div className="workspace__right">
          {showFilters && (
            <form className="filters" onSubmit={applyFilters} data-testid="filter-form">
              <select
                data-testid="filter-ward"
                value={ward}
                onChange={(e) => setWard(e.target.value)}
              >
                <option value="">all wards</option>
                {wardOptions.map((w) => (
                  <option key={w.ward} value={w.ward}>
                    {w.ward} ({w.feature_count})
                  </option>
                ))}
              </select>
              <select
                data-testid="filter-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">all categories</option>
                {categoryOptions.map((c) => (
                  <option key={c.category} value={c.category}>
                    {c.category} ({c.count})
                  </option>
                ))}
              </select>
              <input
                data-testid="filter-severity"
                placeholder="min severity"
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
                inputMode="numeric"
              />
              <button type="submit" data-testid="filter-apply">
                Apply
              </button>
              <button
                type="button"
                className="ghost"
                onClick={resetFilters}
                data-testid="filter-reset"
              >
                Reset
              </button>
            </form>
          )}

          <button
            type="button"
            className="icon-btn"
            onClick={toggle}
            data-testid="theme-toggle"
            aria-label="Toggle theme"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--text"
            onClick={() => void logout()}
            data-testid="logout"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="workspace__body" data-testid="workspace-body">
        <Outlet context={outletContext} />
      </main>
    </div>
  );
}

// Keep the browser tab title in sync with the active view.
export function useTabTitle(base = "Davangere Urban Survey") {
  const location = useLocation();
  useEffect(() => {
    const label =
      location.pathname.startsWith("/map")
        ? "Map"
        : location.pathname.startsWith("/datasets")
        ? "Datasets"
        : location.pathname.startsWith("/analytics")
        ? "Analytics"
        : "";
    document.title = label ? `${label} · ${base}` : base;
  }, [location.pathname, base]);
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import type { FeatureFilter } from "../lib/types";
import { searchFeatureFids, type FidSearchResult } from "../lib/features";
import { fetchCategories, fetchWards, type CategoryOption, type WardOption, type DatasetRow } from "../lib/workflow";

interface CategoryMultiSelectProps {
  options: CategoryOption[];
  value: string[];
  onChange: (categories: string[]) => void;
}

function FidSearch({ ward, datasetIds }: { ward?: string; datasetIds: string[] }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FidSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      searchFeatureFids(normalized, { ward: datasetIds.length === 0 ? ward : undefined, datasetIds }, controller.signal)
        .then(({ results: matches }) => {
          setResults(matches);
          setOpen(true);
        })
        .catch((error: Error) => {
          if (error.name !== "AbortError") {
            setResults([]);
            setOpen(true);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [datasetIds, query, ward]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const selectResult = (result: FidSearchResult) => {
    setQuery(String(result.fid));
    setOpen(false);
    navigate(`/map?locateFeature=${encodeURIComponent(result.id)}`);
  };

  return (
    <div className="fid-search" ref={rootRef}>
      <div className="fid-search__input-wrap">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m16.5 16.5 4 4" />
        </svg>
        <input
          value={query}
          placeholder="Search FID"
          aria-label="Search feature by FID"
          data-testid="filter-fid-search"
          autoComplete="off"
          onFocus={() => { if (query.trim()) setOpen(true); }}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (results[0]) selectResult(results[0]);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        {loading && <span className="fid-search__spinner" aria-label="Searching" />}
      </div>
      {open && (
        <div className="fid-search__results" role="listbox" data-testid="fid-search-results">
          {results.map((result) => (
            <button
              type="button"
              role="option"
              key={result.id}
              className="fid-search__result"
              onClick={() => selectResult(result)}
            >
              <b>FID {result.fid}</b>
              <span>{result.category}</span>
              <small>{result.dataset_name}</small>
            </button>
          ))}
          {!loading && results.length === 0 && <div className="fid-search__empty">No matching FID</div>}
        </div>
      )}
    </div>
  );
}

function CategoryMultiSelect({ options, value, onChange }: CategoryMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const sortedOptions = useMemo(
    () => [...options].sort((a, b) => a.category.localeCompare(b.category, undefined, { sensitivity: "base", numeric: true })),
    [options]
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = useMemo(
    () => normalizedQuery
      ? sortedOptions.filter((option) => option.category.toLocaleLowerCase().includes(normalizedQuery))
      : sortedOptions,
    [normalizedQuery, sortedOptions]
  );
  const selected = useMemo(() => new Set(value), [value]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    window.requestAnimationFrame(() => searchRef.current?.focus());
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function toggleCategory(category: string) {
    if (selected.has(category)) onChange(value.filter((item) => item !== category));
    else onChange([...value, category]);
  }

  const label = value.length === 0
    ? "all categories"
    : value.length === 1
      ? value[0]
      : `${value.length} categories selected`;

  return (
    <div className="category-picker" ref={rootRef}>
      <button
        type="button"
        className={`category-picker__trigger${open ? " category-picker__trigger--open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="filter-category"
        title={value.length > 0 ? value.join(", ") : "All categories"}
      >
        <span className="category-picker__trigger-label">{label}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5.5 7.5 10 12l4.5-4.5" />
        </svg>
      </button>

      {open && (
        <div className="category-picker__menu" data-testid="filter-category-menu">
          <div className="category-picker__search-wrap">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m16.5 16.5 4 4" />
            </svg>
            <input
              ref={searchRef}
              className="category-picker__search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              placeholder="Search categories..."
              aria-label="Search categories"
              data-testid="filter-category-search"
            />
          </div>

          <div className="category-picker__list" role="listbox" aria-multiselectable="true">
            {!normalizedQuery && (
              <button
                type="button"
                role="option"
                aria-selected={value.length === 0}
                className={`category-picker__option${value.length === 0 ? " category-picker__option--selected" : ""}`}
                onClick={() => onChange([])}
              >
                <span className="category-picker__check" aria-hidden="true">{value.length === 0 ? "✓" : ""}</span>
                <span className="category-picker__name">All categories</span>
              </button>
            )}
            {visibleOptions.map((option) => {
              const isSelected = selected.has(option.category);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`category-picker__option${isSelected ? " category-picker__option--selected" : ""}`}
                  key={option.category}
                  onClick={() => toggleCategory(option.category)}
                  data-testid={`filter-category-option-${option.category}`}
                >
                  <span className="category-picker__check" aria-hidden="true">{isSelected ? "✓" : ""}</span>
                  <span className="category-picker__name">{option.category}</span>
                  <span className="category-picker__count">{option.count}</span>
                </button>
              );
            })}
            {visibleOptions.length === 0 && (
              <div className="category-picker__empty">No matching categories</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [categories, setCategories] = useState<string[]>([]);
  const [severity, setSeverity] = useState("");
  const [filter, setFilter] = useState<FeatureFilter>({});
  const [wardOptions, setWardOptions] = useState<WardOption[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[]>([]);
  const [selectedDatasets, setSelectedDatasets] = useState<DatasetRow[]>([]);
  const selectedDatasetIds = useMemo(() => selectedDatasets.map((dataset) => dataset.id), [selectedDatasets]);

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
      .catch(() => { });
    return () => ctrl.abort();
  }, [showFilters, ward]);

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    const next: FeatureFilter = {};
    if (ward.trim()) next.ward = ward.trim();
    if (categories.length > 0) {
      next.categories = [...categories].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
      // Keep the existing single-category AI tools available when exactly
      // one option is selected. Multi-category map filtering uses `categories`.
      if (categories.length === 1) next.category = categories[0];
    }
    if (severity.trim() && !Number.isNaN(Number(severity))) next.severity = Number(severity);
    setFilter(next);
  }

  function resetFilters() {
    setWard("");
    setCategories([]);
    setSeverity("");
    setFilter({});
  }

  // Reflect the ward of the currently selected dataset(s) in the top-bar ward
  // filter so its name is visible even before "Apply" — selecting a dataset
  // on the map should surface the ward there, not leave it on "all wards".
  const handleActiveDatasetsChange = useCallback((datasets: DatasetRow[]) => {
    setSelectedDatasets(datasets);
    const firstWard = datasets.find((d) => d.ward)?.ward ?? "";
    setWard(firstWard);
  }, [setSelectedDatasets]);

  const outletContext = useMemo(
    () => ({ filter, selectedDatasets, setSelectedDatasets: handleActiveDatasetsChange }),
    [filter, selectedDatasets, handleActiveDatasetsChange]
  );

  return (
    <div className="workspace" data-testid="workspace">
      <header className="workspace__topbar" data-testid="topbar">
        <div className="workspace__brand">
          <span className="workspace__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <circle cx="6" cy="18" r="2.1" fill="currentColor" />
              <circle cx="13" cy="9.5" r="2.1" fill="currentColor" />
              <circle cx="19" cy="14" r="2.1" fill="currentColor" />
              <circle cx="19" cy="5.5" r="2.1" fill="currentColor" />
              <path
                d="M6 18L13 9.5M13 9.5L19 14M13 9.5L19 5.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <div>
            <div className="workspace__title">Urban Intelligence</div>
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
                {ward && !wardOptions.some((w) => w.ward === ward) && (
                  <option key={ward} value={ward}>
                    {ward} (selected)
                  </option>
                )}
              </select>
              <CategoryMultiSelect
                options={categoryOptions}
                value={categories}
                onChange={setCategories}
              />
              <FidSearch ward={ward || undefined} datasetIds={selectedDatasetIds} />
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

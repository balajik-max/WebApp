import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
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

const TABS = [
  { to: "/map", label: "Map", testId: "tab-map" },
  { to: "/datasets", label: "Datasets", testId: "tab-datasets" },
  { to: "/analytics", label: "Analytics", testId: "tab-analytics" },
] as const;

/** Which tab a pathname belongs to — the single mapping used both to render
 * NavLink's own `active` class (for aria-current, focus, etc.) and to
 * position the shared sliding indicator, so there's only ever one source of
 * truth for "which tab is active" (never local click state + pathname as
 * two separate answers that can disagree). */
function tabIndexForPath(pathname: string): number {
  const index = TABS.findIndex((tab) => pathname.startsWith(tab.to));
  return index === -1 ? 0 : index;
}

/**
 * MAP / DATASETS / ANALYTICS tabs with one shared green sliding indicator
 * (Google-Earth-Pro-nav-style, not per-tab backgrounds). The indicator is a
 * single absolutely-positioned element measured against whichever tab is
 * active and moved with a CSS transform — nothing is ever removed/recreated
 * on route change, so it can never flash grey or disappear-and-reappear the
 * way stacking two independent `.active` backgrounds on different DOM nodes
 * would.
 */
function TabsNav({ pathname }: { pathname: string }) {
  const tabRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  // Starts false so the very first measurement is applied with transitions
  // off (see the .is-animation-ready gate in CSS) — otherwise a direct load
  // of /datasets or /analytics would visibly fly the indicator in from the
  // left/MAP position instead of appearing already in place.
  const [animationReady, setAnimationReady] = useState(false);

  // The route is the single source of truth for which tab is "really"
  // active (back/forward, direct URL, refresh all flow through pathname).
  // visualActiveIndex additionally lets a click move the indicator the
  // instant it happens, without waiting for the router's re-render —
  // synced back to the real route below the moment pathname changes.
  const activeIndex = tabIndexForPath(pathname);
  const [visualActiveIndex, setVisualActiveIndex] = useState(activeIndex);
  useEffect(() => {
    setVisualActiveIndex(activeIndex);
  }, [activeIndex]);

  const measure = useCallback(() => {
    const el = tabRefs.current[visualActiveIndex];
    const list = listRef.current;
    if (!el || !list) return;
    const listRect = list.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    setIndicator({ left: elRect.left - listRect.left, width: elRect.width });
  }, [visualActiveIndex]);

  // useLayoutEffect (not useEffect) so the measurement is applied before
  // the browser paints — the indicator never visibly jumps from a stale
  // position to the correct one on the same frame.
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // First-paint-only: position with transitions off, then flip
  // animation-ready on the next frame so every subsequent move animates.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setAnimationReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Keeps the indicator aligned across anything that can change tab
  // geometry post-mount: viewport resize, font swap reflow, browser zoom,
  // or the tab list itself changing width/spacing — without re-measuring
  // on every unrelated render.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <nav className="tabs" aria-label="Main application pages" data-testid="tabs">
      <div className={`tabs__list${animationReady ? " is-animation-ready" : ""}`} ref={listRef} role="tablist">
        {indicator && (
          <span
            className="tabs__indicator"
            aria-hidden="true"
            style={{ width: `${indicator.width}px`, transform: `translate3d(${indicator.left}px, 0, 0)` }}
          />
        )}
        {TABS.map((tab, index) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            data-testid={tab.testId}
            ref={(el) => { tabRefs.current[index] = el; }}
            onClick={() => setVisualActiveIndex(index)}
            className={({ isActive }) => (isActive ? "active" : undefined)}
            aria-current={index === activeIndex ? "page" : undefined}
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
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
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [ward, setWard] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [severity, setSeverity] = useState("");
  const [filter, setFilter] = useState<FeatureFilter>({});
  const [wardOptions, setWardOptions] = useState<WardOption[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[]>([]);
  const [selectedDatasets, setSelectedDatasets] = useState<DatasetRow[]>([]);
  const selectedDatasetIds = useMemo(() => selectedDatasets.map((dataset) => dataset.id), [selectedDatasets]);

  // Display-only mirror of the Measure tool's active state, driven by MapCanvas
  // (the sole owner of the real state) so the top-bar button can show the
  // active state. `measureToggle` is the imperative handler registered by the
  // map view — clicking the button calls the map's existing toggle.
  const [measureActive, setMeasureActive] = useState(false);
  const [measureToggle, setMeasureToggle] = useState<() => void>(() => () => {});
  const registerMeasure = useCallback((api: { toggle: () => void }) => {
    setMeasureToggle(() => api.toggle);
  }, []);

  // Global "drag a file onto Map/Analytics → redirect to Datasets" —
  // listens at the window level (not per-page) so it survives the
  // Map/Analytics/Datasets <Outlet> swap: WorkspaceLayout itself never
  // unmounts between tabs, only its child route does. Only ever reacts to
  // an actual file drag (dataTransfer.types includes "Files"), never to
  // ordinary mouse drags (map pan, chart drag, text selection, etc.),
  // which don't carry that type at all.
  const locationRef = useRef(location);
  useEffect(() => { locationRef.current = location; }, [location]);

  useEffect(() => {
    // A drag can fire dragenter/dragleave repeatedly as the pointer moves
    // across nested child elements (map canvas, SVG icons, chart nodes...).
    // Tracking enter/leave depth (rather than a plain boolean) is the
    // standard fix so those nested transitions don't flicker the state or,
    // worse, fire more than one navigation for a single continuous drag.
    let dragDepth = 0;
    let hasRedirectedForCurrentDrag = false;

    const isFileDrag = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const resetDragState = () => {
      dragDepth = 0;
      hasRedirectedForCurrentDrag = false;
    };

    const handleDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth += 1;
      if (hasRedirectedForCurrentDrag) return;

      const pathname = locationRef.current.pathname;
      const shouldRedirectForUpload = pathname === "/map" || pathname === "/analytics";
      if (!shouldRedirectForUpload) return;

      hasRedirectedForCurrentDrag = true;
      navigate("/datasets", { state: { incomingFileDrag: true, sourceRoute: pathname } });
    };

    const handleDragOver = (event: DragEvent) => {
      // Prevent the browser's default "navigate to/open the local file"
      // behavior for any file drag anywhere in the app — required for
      // drop to work at all, and for Test J (dropping never opens the file).
      if (isFileDrag(event)) event.preventDefault();
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) hasRedirectedForCurrentDrag = false;
    };

    const handleDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      // Only preventDefault for the fallback case where the drop lands
      // somewhere the Datasets dropzone doesn't already own (e.g. it
      // still landed on Map/Analytics because the OS drag ended before
      // the SPA route swap completed) — stops the browser from opening
      // the file. The Datasets dropzone's own onDrop calls
      // stopPropagation implicitly by preventDefault + handling it, so
      // this only ever fires for drops the dropzone didn't already claim.
      event.preventDefault();
      resetDragState();
    };

    const handleWindowDragEnd = () => resetDragState();

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    // Fires when a drag that started inside the browser ends without a
    // drop (e.g. Escape, or releasing outside the window) — resets state
    // the same as a leave/drop would.
    window.addEventListener("dragend", handleWindowDragEnd);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragend", handleWindowDragEnd);
    };
    // Intentionally mounted once — reads the current route via
    // locationRef.current rather than depending on `location`/`navigate`,
    // so tab switches never tear down and re-add these listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showFilters = location.pathname.startsWith("/map");

  // Reset only appears once Apply has actually been clicked — before that
  // there's nothing to reset, so showing both buttons up front was just
  // visual noise. Reset swaps back to showing Apply so the same slot is
  // reused rather than the two buttons stacking side by side.
  const [filtersApplied, setFiltersApplied] = useState(false);

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
    setFiltersApplied(true);
  }

  function resetFilters() {
    setWard("");
    setCategories([]);
    setSeverity("");
    setFilter({});
    setFiltersApplied(false);
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
    () => ({
      filter,
      selectedDatasets,
      setSelectedDatasets: handleActiveDatasetsChange,
      measureActive,
      onMeasureChange: setMeasureActive,
      registerMeasure,
    }),
    [filter, selectedDatasets, handleActiveDatasetsChange, measureActive, registerMeasure]
  );

  return (
    <div className="workspace" data-testid="workspace">
      <header className="workspace__topbar" data-testid="topbar">
        <NavLink to="/map" className="workspace__brand" data-testid="brand-home">
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
          <div className="workspace__title">Urban Intelligence</div>
        </NavLink>

        <TabsNav pathname={location.pathname} />

        <div className="workspace__right">
          <button
            type="button"
            className="user-avatar"
            onClick={() => navigate("/profile")}
            data-testid="topbar-user"
            title={user ? `${user.name} · ${user.role}` : "Profile"}
            aria-label={user ? `Open profile for ${user.name}` : "Open profile"}
          >
            {(user?.name ?? "?").trim().charAt(0).toUpperCase()}
          </button>
        </div>
      </header>

      {showFilters && (
        <header className="workspace__subbar" data-testid="subbar">
          <form className="filters" onSubmit={applyFilters} data-testid="filter-form">
            <FidSearch ward={ward || undefined} datasetIds={selectedDatasetIds} />
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
            <input
              data-testid="filter-severity"
              placeholder="min severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              inputMode="numeric"
            />
            {filtersApplied ? (
              <button
                type="button"
                className="ghost"
                onClick={resetFilters}
                data-testid="filter-reset"
              >
                Reset
              </button>
            ) : (
              <button type="submit" data-testid="filter-apply">
                Apply
              </button>
            )}
            <button
              type="button"
              className={`ghost topbar-measure-btn${
                measureActive ? " topbar-measure-btn--active" : ""
              }`}
              onClick={measureToggle}
              title="Measure"
              aria-label="Open Measure tools"
              aria-pressed={measureActive}
              data-testid="topbar-measure"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2.5" y="8" width="19" height="8" rx="1.5" transform="rotate(-45 12 12)" />
                <g transform="rotate(-45 12 12)">
                  <path d="M6 8v3M9.5 8v2M13 8v3M16.5 8v2" />
                </g>
              </svg>
            </button>
          </form>
        </header>
      )}

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
            : location.pathname.startsWith("/profile")
              ? "Profile"
              : "";
    document.title = label ? `${label} · ${base}` : base;
  }, [location.pathname, base]);
}

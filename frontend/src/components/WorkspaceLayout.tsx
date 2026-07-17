import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type TransitionEvent,
} from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import type { FeatureFilter } from "../lib/types";
import { searchFeatureFids, type FidSearchResult } from "../lib/features";
import type { DatasetRow } from "../lib/workflow";

type ClearButtonPhase = "hidden" | "detaching" | "visible" | "reattaching";

// Stable reference so passing it through outletContext every render never
// looks like a change to consumers that depend on `filter` (e.g. MapCanvas's
// data-fetch effect) — filtering UI was removed, so this is always empty.
const EMPTY_FILTER: FeatureFilter = {};

function FidSearch({ datasetIds }: { datasetIds: string[] }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FidSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [clearPhase, setClearPhase] = useState<ClearButtonPhase>("hidden");
  const phaseRef = useRef<ClearButtonPhase>("hidden");

  const setPhase = useCallback((next: ClearButtonPhase) => {
    phaseRef.current = next;
    setClearPhase(next);
  }, []);

  const hasSearchText = query.trim().length > 0;

  // Drive the detach / reattach animation from the input content so typing
  // extra characters never restarts the transition and manual Backspace to
  // empty triggers the same reverse merge as clicking clear.
  useEffect(() => {
    if (hasSearchText) {
      if (phaseRef.current === "hidden" || phaseRef.current === "reattaching") {
        setPhase("detaching");
      }
    } else if (phaseRef.current === "detaching" || phaseRef.current === "visible") {
      setPhase("reattaching");
    }
  }, [hasSearchText, setPhase]);

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
      searchFeatureFids(normalized, { datasetIds }, controller.signal)
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
  }, [datasetIds, query]);

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

  const clearQuery = () => {
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  const handleAnimatedClear = useCallback(() => {
    // Ignore repeated clicks while the reverse merge is already running.
    if (phaseRef.current === "reattaching") return;
    clearQuery();
    // Keep focus on the input so the user can immediately type again.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const handleClearTransitionEnd = (event: TransitionEvent<HTMLButtonElement>) => {
    // Only the geometric transition ends the phase so a faster opacity
    // transition cannot prematurely flip state.
    if (event.propertyName !== "transform") return;
    if (phaseRef.current === "detaching") {
      setPhase("visible");
    } else if (phaseRef.current === "reattaching") {
      setPhase("hidden");
    }
  };

  const clearInteractive = clearPhase === "visible";

  const searchClass = [
    "fid-search",
    clearPhase === "detaching" && "fid-search--detaching",
    clearPhase === "visible" && "fid-search--clear-visible",
    clearPhase === "reattaching" && "fid-search--reattaching",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={searchClass} ref={rootRef}>
      <div className="fid-search__field">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m16.5 16.5 4 4" />
        </svg>
        <input
          ref={inputRef}
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
        <span className="fid-search__seam" aria-hidden="true" />
      </div>

      <button
        type="button"
        className="fid-search__clear"
        onClick={handleAnimatedClear}
        onPointerDown={(event) => event.preventDefault()}
        onTransitionEnd={handleClearTransitionEnd}
        aria-label="Clear search"
        aria-hidden={!clearInteractive}
        tabIndex={clearInteractive ? 0 : -1}
        data-testid="filter-fid-search-clear"
      >
        <span className="fid-search__clear-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </span>
      </button>

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

  const [selectedDatasets, setSelectedDatasets] = useState<DatasetRow[]>([]);
  const selectedDatasetIds = useMemo(() => selectedDatasets.map((dataset) => dataset.id), [selectedDatasets]);

  const showSearch = location.pathname.startsWith("/map");

  const outletContext = useMemo(
    () => ({
      filter: EMPTY_FILTER,
      selectedDatasets,
      setSelectedDatasets,
    }),
    [selectedDatasets]
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

        {showSearch && (
          <div className="workspace__search">
            <FidSearch datasetIds={selectedDatasetIds} />
          </div>
        )}

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

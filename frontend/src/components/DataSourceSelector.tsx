import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DatasetRow } from "../lib/workflow";
import {
  COLOR_MODE_OPTIONS,
  DEFAULT_RASTER_SETTINGS,
  resolveRasterSettings,
  type RasterDisplaySettings,
} from "./MapCanvas";

interface DataSourceSelectorProps {
  datasets: DatasetRow[];
  activeDatasetIds: string[];
  onSelectDataset: (d: DatasetRow) => void;
  onSelectAllDatasets: (active: boolean) => void;
  expandedDatasetId: string | null;
  onToggleDatasetSettings: (datasetId: string) => void;
  rasterSettingsById: Record<string, RasterDisplaySettings>;
  onChangeRasterSettings: (datasetId: string, patch: Partial<RasterDisplaySettings>) => void;
  flyError: string | null;
  onRunAudit: (datasetIds: string[]) => void;
  auditRunning: boolean;
  auditError: string | null;
}

function DatasetTypeIcon({ fileType }: { fileType: string }) {
  const isRaster = fileType === "geotiff" || fileType.toLowerCase().includes("image");
  if (isRaster) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.6" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

export function DataSourceSelector({
  datasets,
  activeDatasetIds,
  onSelectDataset,
  onSelectAllDatasets,
  expandedDatasetId,
  onToggleDatasetSettings,
  rasterSettingsById,
  onChangeRasterSettings,
  flyError,
  onRunAudit,
  auditRunning,
  auditError,
}: DataSourceSelectorProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);

  const selectedCount = activeDatasetIds.length;
  const allSelected = datasets.length > 0 && selectedCount === datasets.length;
  const hasSelectedDataSources = selectedCount > 0;

  let subheading = "Select needed data";
  if (datasets.length > 0) {
    if (allSelected) subheading = `All ${datasets.length} data sources selected`;
    else if (selectedCount === 1) subheading = "1 data source selected";
    else if (selectedCount > 1) subheading = `${selectedCount} data sources selected`;
  }

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const panelHeight = panelRef.current?.offsetHeight ?? 360;
    let top = rect.bottom + 6;
    if (top + panelHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - panelHeight - 6);
    }
    setCoords({ top, left: rect.left, width: rect.width });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const handleScroll = (event: Event) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleResize = () => setOpen(false);

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [open, updatePosition]);

  // Recompute placement once the panel is measured so it can flip upward when
  // there is not enough room below the trigger.
  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  const handleSelectAll = () => onSelectAllDatasets(true);
  const handleClear = () => onSelectAllDatasets(false);

  const panelId = "dss-panel";

  return (
    <div className="dss">
      <button
        type="button"
        ref={triggerRef}
        className={`dss-trigger${open ? " dss-trigger--open" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="data-source-trigger"
      >
        <span className="dss-trigger__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
            <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
          </svg>
        </span>
        <span className="dss-trigger__body">
          <span className="dss-trigger__main">
            <span className="dss-trigger__title">DATA SOURCES</span>
            <span className="dss-trigger__count">{selectedCount}</span>
          </span>
          <span className="dss-trigger__sub-row">
            <span className="dss-trigger__sub">{subheading}</span>
            <span className={`dss-trigger__chevron${open ? " dss-trigger__chevron--up" : ""}`} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
          </span>
        </span>
      </button>

      {open && coords && (
        <div
          ref={panelRef}
          id={panelId}
          className="dss-panel"
          role="listbox"
          aria-label="Data sources"
          style={{ top: coords.top, left: coords.left, width: coords.width }}
        >
          <div className="dss-panel__header">
            <span className="dss-panel__title">Data Sources</span>
            {hasSelectedDataSources ? (
              <button
                type="button"
                className="dss-clear"
                onClick={handleClear}
                aria-label="Clear selected data sources"
              >
                Clear
              </button>
            ) : (
              <label className="dss-selectall">
                <input
                  type="checkbox"
                  className="dss-checkbox"
                  checked={false}
                  onChange={handleSelectAll}
                  disabled={datasets.length === 0}
                  aria-label="Select all data sources"
                />
                <span>Select All</span>
              </label>
            )}
          </div>

          {activeDatasetIds.length > 0 && (
            <div className="dss-panel__audit">
              <button
                type="button"
                className="command-center__audit-btn"
                disabled={auditRunning}
                onClick={() => onRunAudit(activeDatasetIds)}
                data-testid="run-spatial-audit"
              >
                {auditRunning ? "Running Spatial Audit…" : "Run Spatial Audit"}
              </button>
              {auditError && (
                <div className="dss-panel__audit-error">{auditError}</div>
              )}
            </div>
          )}

          <div className="dss-panel__list">
            {datasets.length === 0 ? (
              <div className="dss-empty">No data sources available</div>
            ) : (
              datasets.map((d) => {
                const isActive = activeDatasetIds.includes(d.id);
                const selectable = d.status === "ready";
                const hasRasterControls = d.status === "ready" && d.file_type === "geotiff" && Boolean(d.dataset_metadata?.raster_overlay);
                const canOpenSettings = hasRasterControls && isActive;
                const isExpanded = canOpenSettings && expandedDatasetId === d.id;
                const rasterSettings = resolveRasterSettings(rasterSettingsById[d.id]);

                return (
                  <div className={`dss-row-shell${isExpanded ? " dss-row-shell--expanded" : ""}`} key={d.id}>
                    <label className={`dss-row${isActive ? " dss-row--active" : ""}${selectable ? "" : " dss-row--disabled"}`}>
                      <input
                        type="checkbox"
                        className="dss-checkbox"
                        checked={isActive}
                        disabled={!selectable}
                        onChange={() => selectable && onSelectDataset(d)}
                        aria-label={d.name}
                      />
                      <span className="dss-row__icon" aria-hidden="true">
                        <DatasetTypeIcon fileType={d.file_type} />
                      </span>
                      <span className="dss-row__info">
                        <span className="dss-row__name" title={d.name}>{d.name}</span>
                        <span className="dss-row__meta">
                          {d.ward ? (
                            <><strong>Ward {d.ward}</strong> · {d.file_type}</>
                          ) : (
                            <>All wards · {d.file_type}</>
                          )}
                        </span>
                      </span>
                      {hasRasterControls ? (
                        <button
                          type="button"
                          className={`dataset-card__gear${isExpanded ? " dataset-card__gear--active" : ""}`}
                          aria-label={`Open display settings for ${d.name}`}
                          aria-expanded={isExpanded}
                          disabled={!canOpenSettings}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!canOpenSettings) return;
                            onToggleDatasetSettings(d.id);
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                          </svg>
                        </button>
                      ) : (
                        <span className={`dataset-card__status dataset-card__status--${d.status}`}>{d.status}</span>
                      )}
                    </label>
                    {canOpenSettings && isExpanded && (
                      <div className="dataset-card__settings" onClick={(event) => event.stopPropagation()}>
                        <div className="dataset-card__settings-head">
                          <div>
                            <div className="dataset-card__settings-title">Display Settings</div>
                            <div className="dataset-card__settings-copy">
                              Default preview already looks correct. Use these only when you need a manual adjustment.
                            </div>
                          </div>
                          <button
                            type="button"
                            className="dataset-card__reset"
                            onClick={() => onChangeRasterSettings(d.id, DEFAULT_RASTER_SETTINGS)}
                          >
                            Reset
                          </button>
                        </div>
                        <div className="dataset-card__settings-group">
                          <div className="dataset-card__settings-label">Color Type</div>
                          <div className="dataset-card__mode-row">
                            {COLOR_MODE_OPTIONS.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                className={`dataset-card__mode-btn${rasterSettings.colorMode === option.value ? " dataset-card__mode-btn--active" : ""}`}
                                onClick={() => onChangeRasterSettings(d.id, { colorMode: option.value })}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="dataset-card__settings-group">
                          <div className="dataset-card__slider-head">
                            <span className="dataset-card__settings-label">Edge Clarity</span>
                            <span className="dataset-card__slider-value">
                              {rasterSettings.clarity.toFixed(2)}
                            </span>
                          </div>
                          <input
                            className="dataset-card__slider"
                            type="range"
                            min="0"
                            max="2"
                            step="0.05"
                            value={rasterSettings.clarity}
                            onChange={(event) => onChangeRasterSettings(d.id, { clarity: Number(event.target.value) })}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {flyError && (
            <div className="dss-panel__error">{flyError}</div>
          )}
        </div>
      )}
    </div>
  );
}

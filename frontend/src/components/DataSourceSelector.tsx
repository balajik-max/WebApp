import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DatasetRow } from "../lib/workflow";
import {
  COLOR_MODE_OPTIONS,
  DEFAULT_RASTER_SETTINGS,
  resolveRasterSettings,
  type RasterDisplaySettings,
} from "./MapCanvas";

// A dataset exposes raster display controls (Color Type / Edge Clarity) only
// when it is a ready GeoTIFF that carries a pre-baked raster_overlay.
function supportsDisplaySettings(dataset: DatasetRow): boolean {
  return (
    dataset.status === "ready" &&
    dataset.file_type === "geotiff" &&
    Boolean(dataset.dataset_metadata?.raster_overlay)
  );
}

// Keep the Data Source popover mounted briefly after it closes so its
// collapse animation can finish instead of vanishing instantly.
const DSS_PANEL_TRANSITION_MS = 220;

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

function DatasetTypeIcon({ fileType, isModel3d = false }: { fileType: string; isModel3d?: boolean }) {
  if (isModel3d) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2 3.5 6.5v11L12 22l8.5-4.5v-11L12 2Z" />
        <path d="m3.5 6.5 8.5 5 8.5-5M12 11.5V22" />
      </svg>
    );
  }
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
  // Stays true for DSS_PANEL_TRANSITION_MS after `open` goes false, so the
  // panel remains in the DOM long enough to animate closed instead of
  // vanishing instantly.
  const [panelMounted, setPanelMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<number | null>(null);

  // Display-settings cards are rendered for EVERY selected dataset that
  // supports raster display controls (GeoTIFF with a raster_overlay), not
  // just a single focused one. `expandedSettingsIds` tracks which of those
  // collapsible cards are currently open.
  const [expandedSettingsIds, setExpandedSettingsIds] = useState<Set<string>>(new Set());

  const selectedCount = activeDatasetIds.length;
  const allSelected = datasets.length > 0 && selectedCount === datasets.length;
  const hasSelectedDataSources = selectedCount > 0;

  let subheading = "Select needed data";
  if (datasets.length > 0) {
    if (allSelected) subheading = `All ${datasets.length} data sources selected`;
    else if (selectedCount === 1) subheading = "1 data source selected";
    else if (selectedCount > 1) subheading = `${selectedCount} data sources selected`;
  }

  useEffect(() => {
    if (open) {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      setPanelMounted(true);
      return;
    }
    closeTimeoutRef.current = window.setTimeout(() => {
      setPanelMounted(false);
      closeTimeoutRef.current = null;
    }, DSS_PANEL_TRANSITION_MS);
    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

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

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const eligibleSettingsDatasets = useMemo(
    () => datasets.filter((d) => activeDatasetIds.includes(d.id) && supportsDisplaySettings(d)),
    [datasets, activeDatasetIds]
  );

  const toggleSettingsExpanded = useCallback((datasetId: string) => {
    setExpandedSettingsIds((prev) => {
      const next = new Set(prev);
      if (next.has(datasetId)) next.delete(datasetId);
      else next.add(datasetId);
      return next;
    });
  }, []);

  // When a single raster dataset is selected (or its gear is toggled), the
  // parent sets `expandedDatasetId` — automatically open that card so the
  // user sees its settings without hunting for the gear icon.
  useEffect(() => {
    if (!expandedDatasetId) return;
    setExpandedSettingsIds((prev) => {
      if (prev.has(expandedDatasetId)) return prev;
      const next = new Set(prev);
      next.add(expandedDatasetId);
      return next;
    });
  }, [expandedDatasetId]);

  // Reconcile the open-card set with the eligible selection:
  //  - prune ids that are no longer selected / no longer eligible (handles
  //    Clear and partial deselection with no stale cards left behind),
  //  - on "Select All", expand only the first eligible card by default,
  //    leaving the rest collapsed so the panel stays compact.
  const eligibleSignature = eligibleSettingsDatasets.map((d) => d.id).join("|");
  const prevEligibleSignature = useRef<string>("");
  useEffect(() => {
    const previous = prevEligibleSignature.current;
    prevEligibleSignature.current = eligibleSignature;
    setExpandedSettingsIds((prev) => {
      const pruned = new Set([...prev].filter((id) => eligibleSettingsDatasets.some((d) => d.id === id)));
      const isSelectAll = datasets.length > 0 && activeDatasetIds.length === datasets.length;
      if (isSelectAll && previous !== eligibleSignature && pruned.size === 0 && eligibleSettingsDatasets.length > 0) {
        return new Set([eligibleSettingsDatasets[0].id]);
      }
      return pruned;
    });
  }, [eligibleSettingsDatasets, datasets, activeDatasetIds, eligibleSignature]);

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

      <div className={`dss-panel-wrap${open ? " dss-panel-wrap--open" : ""}`} aria-hidden={!open}>
        {panelMounted && (
        <div
          ref={panelRef}
          id={panelId}
          className="dss-panel"
          role="listbox"
          aria-label="Data sources"
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

          <div className="dss-panel__list">
            {datasets.length === 0 ? (
              <div className="dss-empty">No data sources available</div>
            ) : (
              datasets.map((d) => {
                const isActive = activeDatasetIds.includes(d.id);
                const selectable = d.status === "ready";
                const modelMetadata = d.dataset_metadata?.model_3d;
                const hasRasterControls = supportsDisplaySettings(d);
                const canOpenSettings = hasRasterControls && isActive;
                const isExpanded = canOpenSettings && expandedSettingsIds.has(d.id);

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
                        <DatasetTypeIcon fileType={d.file_type} isModel3d={Boolean(modelMetadata)} />
                      </span>
                      <span className="dss-row__info">
                        <span className="dss-row__name" title={d.name}>{d.name}</span>
                        <span className="dss-row__meta">
                          {d.ward ? (
                            <><strong>Ward {d.ward}</strong> · {modelMetadata ? `OBJ 3D · ${modelMetadata.source_crs}` : d.file_type}</>
                          ) : (
                            <>All wards · {modelMetadata ? `OBJ 3D · ${modelMetadata.source_crs}` : d.file_type}</>
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
                            toggleSettingsExpanded(d.id);
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

      {activeDatasetIds.length > 0 && (
        <div className="dss-audit">
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

      <div className={`dss-settings-wrap${activeDatasetIds.length > 0 ? " dss-settings-wrap--open" : ""}`} aria-hidden={activeDatasetIds.length === 0}>
        {activeDatasetIds.length > 0 && eligibleSettingsDatasets.length === 0 && (
          <div className="dss-settings-empty">
            No display settings are available for the selected datasets.
          </div>
        )}
        {eligibleSettingsDatasets.map((dataset) => {
          const settings = resolveRasterSettings(rasterSettingsById[dataset.id]);
          const isOpen = expandedSettingsIds.has(dataset.id);
          const panelId = `ds-settings-${dataset.id}`;
          return (
            <div className="dataset-card__settings dataset-card__settings--standalone" key={dataset.id} data-testid="dataset-settings-panel">
              <div className="dataset-card__settings-head">
                <button
                  type="button"
                  className="dataset-card__settings-toggle"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => toggleSettingsExpanded(dataset.id)}
                >
                  <span className={`dataset-card__chevron${isOpen ? " dataset-card__chevron--up" : ""}`} aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                  <span className="dataset-card__settings-titles">
                    <span className="dataset-card__settings-title">Display Settings</span>
                    <span className="dataset-card__settings-copy">
                      {dataset.name} — default preview already looks correct. Use these only when you need a manual adjustment.
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="dataset-card__reset"
                  onClick={() => onChangeRasterSettings(dataset.id, DEFAULT_RASTER_SETTINGS)}
                >
                  Reset
                </button>
              </div>
              {isOpen && (
                <div id={panelId} className="dataset-card__settings-body">
                  <div className="dataset-card__settings-group">
                    <div className="dataset-card__settings-label">Color Type</div>
                    <div className="dataset-card__mode-row">
                      {COLOR_MODE_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`dataset-card__mode-btn${settings.colorMode === option.value ? " dataset-card__mode-btn--active" : ""}`}
                          onClick={() => onChangeRasterSettings(dataset.id, { colorMode: option.value })}
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
                        {settings.clarity.toFixed(2)}
                      </span>
                    </div>
                    <input
                      className="dataset-card__slider"
                      type="range"
                      min="0"
                      max="2"
                      step="0.05"
                      value={settings.clarity}
                      onChange={(event) => onChangeRasterSettings(dataset.id, { clarity: Number(event.target.value) })}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

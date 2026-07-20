import type { DatasetRow } from "../lib/workflow";
import {
  COLOR_MODE_OPTIONS,
  DEFAULT_RASTER_SETTINGS,
  isGeoTiffDataset,
  resolveRasterSettings,
  type RasterDisplaySettings,
} from "./MapCanvas";

interface DataSourceSelectorProps {
  datasets: DatasetRow[];
  activeDatasetIds: string[];
  open: boolean;
  onToggleOpen: () => void;
  onSelectDataset: (d: DatasetRow) => void;
  onSelectAllDatasets: (active: boolean) => void;
  expandedDatasetId: string | null;
  onToggleDatasetSettings: (datasetId: string) => void;
  rasterSettingsById: Record<string, RasterDisplaySettings>;
  onChangeRasterSettings: (datasetId: string, patch: Partial<RasterDisplaySettings>) => void;
  layerDatasetIds: string[];
  onOpenLayer: (datasetId: string, anchor: HTMLElement) => void;
  flyError: string | null;
}

export function DataSourceSelector({
  datasets,
  activeDatasetIds,
  open,
  onToggleOpen,
  onSelectDataset,
  onSelectAllDatasets,
  expandedDatasetId,
  onToggleDatasetSettings,
  rasterSettingsById,
  onChangeRasterSettings,
  layerDatasetIds,
  onOpenLayer,
  flyError,
}: DataSourceSelectorProps) {
  const selectedCount = activeDatasetIds.length;
  const hasSelectedDataSources = selectedCount > 0;

  const handleSelectAll = () => onSelectAllDatasets(true);
  const handleClear = () => onSelectAllDatasets(false);

  return (
    <div className="dss" role="group" aria-label="Data sources">
      <div className="dss-header">
        <button
          type="button"
          className="dss-heading"
          data-testid="data-source-heading"
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-controls="data-sources-panel"
        >
          <svg className={`dss-heading__chevron${open ? " dss-heading__chevron--open" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
            <path d="m8 10 4 4 4-4" />
          </svg>
          Data Sources
        </button>
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

          {open && <div id="data-sources-panel" className="dss-panel__list">
            {datasets.length === 0 ? (
              <div className="dss-empty">No data sources available</div>
            ) : (
              datasets.map((d) => {
                const isActive = activeDatasetIds.includes(d.id);
                const selectable = d.status === "ready";
                // TIFF/GeoTIFF rasters (including DSM/DTM) are locked to a
                // fixed render mode and expose no display settings. RGB is used
                // for ordinary GeoTIFFs and Enhanced for DSM/DTM.
                const hasRasterControls =
                  d.status === "ready"
                  && Boolean(d.dataset_metadata?.raster_overlay)
                  && !isGeoTiffDataset(d);
                // Vector/GDB datasets keep the coordinate-search branch's
                // layer styling control.
                const hasLayerControls = layerDatasetIds.includes(d.id);

                const canOpenSettings = hasRasterControls && isActive;
                const canOpenLayer = hasLayerControls && isActive;
                const isExpanded = canOpenSettings && expandedDatasetId === d.id;
                const rasterSettings = resolveRasterSettings(rasterSettingsById[d.id]);

                return (
                  <div className={`dss-row-shell${isExpanded ? " dss-row-shell--expanded" : ""}`} key={d.id}>
                    <label
                      className={`dss-row${isActive ? " dss-row--active" : ""}${selectable ? "" : " dss-row--disabled"}${canOpenLayer ? " dss-row--layer-capable" : ""}`}
                      tabIndex={canOpenLayer ? 0 : undefined}
                      title={canOpenLayer ? "Right-click to view layers" : undefined}
                      aria-label={canOpenLayer ? `${d.name}. Right-click or press Shift+F10 to view layers.` : undefined}
                      onContextMenu={(event) => {
                        if (!canOpenLayer) return;
                        event.preventDefault();
                        event.stopPropagation();
                        onOpenLayer(d.id, event.currentTarget);
                      }}
                      onKeyDown={(event) => {
                        if (!canOpenLayer) return;
                        const isContextMenuShortcut = event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
                        if (!isContextMenuShortcut) return;
                        event.preventDefault();
                        onOpenLayer(d.id, event.currentTarget);
                      }}
                    >
                      <input
                        type="checkbox"
                        className="dss-checkbox"
                        checked={isActive}
                        disabled={!selectable}
                        onChange={() => selectable && onSelectDataset(d)}
                        aria-label={d.name}
                      />
                      <span className="dss-row__info">
                        <span className="dss-row__name" title={d.name}>{d.name}</span>
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
                      ) : null}
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
          </div>}

          {open && flyError && (
            <div className="dss-panel__error">{flyError}</div>
          )}
    </div>
  );
}

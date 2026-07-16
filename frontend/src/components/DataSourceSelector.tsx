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
  onSelectDataset: (d: DatasetRow) => void;
  onSelectAllDatasets: (active: boolean) => void;
  expandedDatasetId: string | null;
  onToggleDatasetSettings: (datasetId: string) => void;
  rasterSettingsById: Record<string, RasterDisplaySettings>;
  onChangeRasterSettings: (datasetId: string, patch: Partial<RasterDisplaySettings>) => void;
  flyError: string | null;
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
}: DataSourceSelectorProps) {
  const selectedCount = activeDatasetIds.length;
  const hasSelectedDataSources = selectedCount > 0;

  const handleSelectAll = () => onSelectAllDatasets(true);
  const handleClear = () => onSelectAllDatasets(false);

  return (
    <div className="dss" role="group" aria-label="Data sources">
      <div className="dss-header">
        <div className="dss-heading" data-testid="data-source-heading">Data Sources</div>
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
                // TIFF/GeoTIFF rasters (including DSM/DTM) are locked to a
                // fixed render mode and expose no display settings — so they
                // get no gear and no panel. RGB for ordinary GeoTIFFs,
                // Enhanced for DSM/DTM, both enforced at the rendering layer.
                const hasRasterControls = d.status === "ready" && Boolean(d.dataset_metadata?.raster_overlay) && !isGeoTiffDataset(d);
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
  );
}

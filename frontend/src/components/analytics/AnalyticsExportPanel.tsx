import { useMemo, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  downloadAnalyticsExport,
  type AnalyticsCrossFilters,
  type AnalyticsExportFormat,
} from "../../lib/workflow";

interface AnalyticsExportPanelProps {
  datasetIds: string[];
  categories: string[];
  filters?: AnalyticsCrossFilters;
  disabledReason?: string | null;
}

interface ExportOption {
  format: AnalyticsExportFormat;
  title: string;
  description: string;
  useCase: string;
}

const OPTIONS: ExportOption[] = [
  {
    format: "xlsx",
    title: "Excel workbook",
    description: "Summary, scoped feature list, and Recommended Attention Order in separate sheets.",
    useCase: "Best for engineers and detailed review",
  },
  {
    format: "pdf",
    title: "PDF report",
    description: "Management-ready summary of scope, KPIs, quality score, and priority findings.",
    useCase: "Best for sharing and approvals",
  },
  {
    format: "csv",
    title: "CSV feature list",
    description: "Flat table of every feature in the applied scope, including attributes and WKT.",
    useCase: "Best for quick data processing",
  },
  {
    format: "geojson",
    title: "GeoJSON",
    description: "GIS-ready spatial features with EPSG:4326 geometry and source properties.",
    useCase: "Best for QGIS, ArcGIS, and GIS exchange",
  },
];

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail?: unknown }).detail;
      if (typeof detail === "string") return detail;
    }
  }
  return error instanceof Error ? error.message : "Export failed. Please try again.";
}

export function AnalyticsExportPanel({
  datasetIds,
  categories,
  filters = {},
  disabledReason,
}: AnalyticsExportPanelProps) {
  const [exporting, setExporting] = useState<AnalyticsExportFormat | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scopeLabel = useMemo(() => {
    const datasetText = datasetIds.length === 0
      ? "all datasets"
      : `${datasetIds.length} selected dataset${datasetIds.length === 1 ? "" : "s"}`;
    const categoryText = categories.length === 0
      ? "all categories"
      : `${categories.length} selected categor${categories.length === 1 ? "y" : "ies"}`;
    const wardText = filters.wards?.length ? `, ${filters.wards.join(", ")}` : "";
    const severityText = filters.severityBuckets?.length
      ? `, ${filters.severityBuckets.join(", ")} severity`
      : "";
    return `${datasetText}, ${categoryText}${wardText}${severityText}`;
  }, [categories.length, datasetIds.length, filters.severityBuckets, filters.wards]);

  async function runExport(format: AnalyticsExportFormat) {
    setExporting(format);
    setError(null);
    setMessage(null);
    try {
      const filename = await downloadAnalyticsExport(
        format,
        datasetIds,
        categories,
        filters
      );
      setMessage(`${filename} downloaded from the applied Analytics scope.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setExporting(null);
    }
  }

  return (
    <section className="chart-card analytics-export-panel" data-testid="analytics-export-panel">
      <div className="chart-card__header analytics-export-panel__header">
        <div>
          <div className="analytics-card-eyebrow">Use the results</div>
          <h3 className="chart-card__title">Export Applied Analysis</h3>
          <p className="analytics-export-panel__intro">
            Download exactly what is currently analyzed - not the entire database.
          </p>
        </div>
        <span className="chart-card__badge">{scopeLabel}</span>
      </div>

      <div className="chart-card__body">
        {disabledReason && (
          <div className="analytics-export-panel__notice" role="status">
            {disabledReason}
          </div>
        )}

        <div className="analytics-export-grid">
          {OPTIONS.map((option) => {
            const busy = exporting === option.format;
            return (
              <button
                key={option.format}
                type="button"
                className="analytics-export-option"
                onClick={() => runExport(option.format)}
                disabled={Boolean(disabledReason) || exporting !== null}
                aria-busy={busy}
              >
                <span className={`analytics-export-option__icon analytics-export-option__icon--${option.format}`}>
                  {option.format.toUpperCase()}
                </span>
                <span className="analytics-export-option__copy">
                  <strong>{busy ? "Preparing..." : option.title}</strong>
                  <span>{option.description}</span>
                  <small>{option.useCase}</small>
                </span>
                <span className="analytics-export-option__arrow" aria-hidden="true">↓</span>
              </button>
            );
          })}
        </div>

        {message && <div className="analytics-export-panel__success" role="status">{message}</div>}
        {error && <div className="analytics-export-panel__error" role="alert">{error}</div>}
        <p className="analytics-export-panel__footnote">
          Detailed CSV, Excel, and GeoJSON exports are limited to 50,000 scoped features per download.
          Apply narrower filters when the scope is larger.
        </p>
      </div>
    </section>
  );
}

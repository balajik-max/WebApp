import { useEffect, useMemo, useState } from "react";
import {
  fetchManholeReadiness,
  type AnalyticsCrossFilters,
  type ManholeReadinessFieldKey,
  type ManholeReadinessReport,
  type ManholeReadinessStatus,
} from "../../lib/workflow";

interface Props {
  datasetIds: string[];
  filters: Pick<AnalyticsCrossFilters, "wards" | "severityBuckets">;
  activeField: ManholeReadinessFieldKey | null;
  activeStatus: ManholeReadinessStatus | null;
  onSelect: (
    field: ManholeReadinessFieldKey,
    label: string,
    status: ManholeReadinessStatus
  ) => void;
  onClear: () => void;
}

function fieldTone(completeness: number) {
  if (completeness >= 80) return "good";
  if (completeness >= 50) return "warn";
  return "danger";
}

export function AnalyticsManholeReadiness({
  datasetIds,
  filters,
  activeField,
  activeStatus,
  onSelect,
  onClear,
}: Props) {
  const [report, setReport] = useState<ManholeReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = useMemo(
    () => JSON.stringify({
      datasetIds: [...datasetIds].sort(),
      wards: [...(filters.wards ?? [])].sort(),
      severityBuckets: [...(filters.severityBuckets ?? [])].sort(),
    }),
    [datasetIds, filters.severityBuckets, filters.wards]
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchManholeReadiness(datasetIds, controller.signal, filters)
      .then(setReport)
      .catch((caught: Error) => {
        if (caught.name !== "AbortError") setError(caught.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // scopeKey contains the normalized dataset, ward, and severity scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  return (
    <section className="chart-card analytics-readiness-card" data-testid="manhole-data-readiness">
      <div className="chart-card__header analytics-readiness-card__header">
        <div>
          <div className="analytics-card-eyebrow">Field verification</div>
          <h3 className="chart-card__title">Manhole Data Readiness</h3>
          <p className="analytics-readiness-card__intro">
            Click a card to compare all Manholes in green and red, or choose Available or Missing to isolate one status.
          </p>
        </div>
        <div className="analytics-readiness-card__summary">
          <span className="chart-card__badge">
            {report ? `${report.total_manhole_features.toLocaleString()} Manholes` : "Loading"}
          </span>
          {activeField && (
            <button type="button" onClick={onClear} className="analytics-readiness-card__clear">
              Clear readiness view
            </button>
          )}
        </div>
      </div>

      <div className="chart-card__body">
        {loading && <div className="analytics-page__loading">Checking existing Manhole attributes…</div>}
        {error && <div className="analytics-inline-error">Manhole readiness unavailable: {error}</div>}
        {!loading && !error && report?.total_manhole_features === 0 && (
          <div className="analytics-quality-empty-state">
            No Manhole features exist in the selected dataset, ward, and severity scope.
          </div>
        )}
        {!loading && !error && report && report.total_manhole_features > 0 && (
          <>
            <div className="analytics-readiness-grid">
              {report.fields.map((field) => {
                const active = activeField === field.key;
                const tone = fieldTone(field.completeness_percentage);
                return (
                  <article
                    key={field.key}
                    className={`analytics-readiness-row analytics-readiness-row--${tone}${active ? " is-active" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={active && activeStatus === "all"}
                    onClick={() => onSelect(field.key, field.label, "all")}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(field.key, field.label, "all");
                      }
                    }}
                    title={`Show all ${report.total_manhole_features} Manholes by ${field.label} readiness`}
                  >
                    <div className="analytics-readiness-row__title">
                      <div>
                        <strong>{field.label}</strong>
                        <small>{field.recommended_action}</small>
                      </div>
                      <b>{field.completeness_percentage.toFixed(1)}% complete</b>
                    </div>
                    <div className="analytics-readiness-track" aria-hidden="true">
                      <i style={{ width: `${Math.max(0, Math.min(100, field.completeness_percentage))}%` }} />
                    </div>
                    <div className="analytics-readiness-row__counts">
                      <button
                        type="button"
                        className={`analytics-readiness-count analytics-readiness-count--available${active && activeStatus === "available" ? " is-active" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(field.key, field.label, "available");
                        }}
                        disabled={field.available_count === 0}
                        aria-pressed={active && activeStatus === "available"}
                        title={`Show ${field.available_count} Manholes with ${field.label}`}
                      >
                        <b>{field.available_count.toLocaleString()}</b> Available
                        <span aria-hidden="true">→</span>
                      </button>
                      <button
                        type="button"
                        className={`analytics-readiness-count analytics-readiness-count--missing${active && activeStatus === "missing" ? " is-active" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(field.key, field.label, "missing");
                        }}
                        disabled={field.missing_count === 0}
                        aria-pressed={active && activeStatus === "missing"}
                        title={
                          field.missing_count === 0
                            ? `All ${field.label} values are available`
                            : `Show ${field.missing_count} Manholes missing ${field.label}`
                        }
                      >
                        <b>{field.missing_count.toLocaleString()}</b> Missing
                        <span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <details className="analytics-methodology analytics-readiness-methodology">
              <summary>How missing values are identified</summary>
              <p>{report.methodology}</p>
            </details>
          </>
        )}
      </div>
    </section>
  );
}

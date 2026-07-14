import { useEffect, useMemo, useState } from "react";
import {
  fetchManholeReadiness,
  type AnalyticsCrossFilters,
  type ManholeReadinessFieldKey,
  type ManholeReadinessReport,
} from "../../lib/workflow";

interface Props {
  datasetIds: string[];
  filters: Pick<AnalyticsCrossFilters, "wards" | "severityBuckets">;
  activeField: ManholeReadinessFieldKey | null;
  onSelectMissing: (field: ManholeReadinessFieldKey, label: string) => void;
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
  onSelectMissing,
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
            Click a missing count to locate every affected Manhole on the map and in the feature table.
          </p>
        </div>
        <div className="analytics-readiness-card__summary">
          <span className="chart-card__badge">
            {report ? `${report.total_manhole_features.toLocaleString()} Manholes` : "Loading"}
          </span>
          {activeField && (
            <button type="button" onClick={onClear} className="analytics-readiness-card__clear">
              Show all Manholes
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
                      <span className="analytics-readiness-count analytics-readiness-count--available">
                        <b>{field.available_count.toLocaleString()}</b> Available
                      </span>
                      <button
                        type="button"
                        className="analytics-readiness-count analytics-readiness-count--missing"
                        onClick={() => onSelectMissing(field.key, field.label)}
                        disabled={field.missing_count === 0}
                        aria-pressed={active}
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

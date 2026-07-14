import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  fetchAnalyticsQuality,
  type AnalyticsCrossFilters,
  type AnalyticsFinding,
  type AnalyticsQualityReport,
} from "../../lib/workflow";

interface Props {
  datasetIds: string[];
  categories: string[];
  filters: AnalyticsCrossFilters;
  onCategoryFilter?: (category: string) => void;
}

function scoreTone(score: number | null) {
  if (score == null) return "neutral";
  if (score >= 90) return "good";
  if (score >= 75) return "warn";
  return "danger";
}

function FindingRow({
  finding,
  onLocate,
  onCategoryFilter,
}: {
  finding: AnalyticsFinding;
  onLocate: (finding: AnalyticsFinding) => void;
  onCategoryFilter?: (category: string) => void;
}) {
  return (
    <tr>
      <td>
        <span className={`analytics-finding-severity analytics-finding-severity--${finding.severity}`}>
          {finding.severity}
        </span>
      </td>
      <td>
        <strong>{finding.title}</strong>
        <small>{finding.description}</small>
        <details>
          <summary>Rule used</summary>
          <code>{finding.rule}</code>
        </details>
      </td>
      <td className="analytics-number-cell">{finding.affected_count.toLocaleString()}</td>
      <td className="analytics-number-cell">{finding.affected_percentage.toFixed(1)}%</td>
      <td className="analytics-number-cell"><b>{finding.priority_score}</b></td>
      <td>
        <div className="analytics-finding-actions">
          {finding.category && onCategoryFilter && (
            <button type="button" onClick={() => onCategoryFilter(finding.category!)}>
              Filter category
            </button>
          )}
          <button
            type="button"
            onClick={() => onLocate(finding)}
            disabled={finding.feature_ids.length === 0}
            title={finding.feature_ids.length === 0 ? "No feature evidence is available for this aggregate finding" : "Open the first available affected feature on the main map"}
          >
            Show first evidence
          </button>
        </div>
      </td>
    </tr>
  );
}

export function AnalyticsQualityPanel({ datasetIds, categories, filters, onCategoryFilter }: Props) {
  const navigate = useNavigate();
  const [report, setReport] = useState<AnalyticsQualityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = useMemo(
    () => JSON.stringify({
      datasetIds: [...datasetIds].sort(),
      categories: [...categories].sort(),
      wards: [...(filters.wards ?? [])].sort(),
      severityBuckets: [...(filters.severityBuckets ?? [])].sort(),
    }),
    [categories, datasetIds, filters.severityBuckets, filters.wards]
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchAnalyticsQuality(datasetIds, categories, controller.signal, filters)
      .then(setReport)
      .catch((caught: Error) => {
        if (caught.name !== "AbortError") setError(caught.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // scopeKey intentionally captures the normalized scope and prevents noisy reruns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  function locateFinding(finding: AnalyticsFinding) {
    const firstFeatureId = finding.feature_ids[0];
    if (!firstFeatureId) return;
    navigate(`/map?locateFeature=${encodeURIComponent(firstFeatureId)}`);
  }

  const score = report?.overall_score ?? null;
  const findings = report?.findings ?? [];

  return (
    <section className="chart-card analytics-quality-card" data-testid="analytics-quality-intelligence">
      <div className="chart-card__header">
        <div>
          <div className="analytics-card-eyebrow">Verified intelligence</div>
          <h3 className="chart-card__title">Data Quality & Priority Findings</h3>
        </div>
        {report && (
          <span className={`analytics-quality-score analytics-quality-score--${scoreTone(score)}`}>
            {score == null ? "No score" : `${score.toFixed(1)}/100`}
          </span>
        )}
      </div>
      <div className="chart-card__body">
        {loading && <div className="analytics-page__loading">Running deterministic PostGIS and attribute checks…</div>}
        {error && <div className="analytics-inline-error">Quality analysis unavailable: {error}</div>}
        {!loading && !error && report && report.total_features === 0 && (
          <div className="analytics-quality-empty-state">No features match the current Analytics scope.</div>
        )}
        {!loading && !error && report && report.total_features > 0 && (
          <>
            <div className="analytics-quality-components">
              {report.components.map((component) => (
                <article key={component.key} title={component.explanation}>
                  <div>
                    <span>{component.label}</span>
                    <b>{component.score.toFixed(1)}%</b>
                  </div>
                  <div className="analytics-quality-track">
                    <i style={{ width: `${Math.max(0, Math.min(100, component.score))}%` }} />
                  </div>
                  <small>{component.failed.toLocaleString()} failed checks · weight {component.weight}%</small>
                </article>
              ))}
            </div>

            <div className="analytics-findings-head">
              <div>
                <h4>Recommended attention order</h4>
                <p>Ranked from deterministic severity, affected share, and scale. AI does not calculate these numbers.</p>
              </div>
              <span>{findings.length} verified findings</span>
            </div>

            {findings.length > 0 ? (
              <div className="analytics-findings-table-wrap">
                <table className="analytics-findings-table">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Finding</th>
                      <th>Affected</th>
                      <th>Scope</th>
                      <th>Priority</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.map((finding) => (
                      <FindingRow
                        key={finding.id}
                        finding={finding}
                        onLocate={locateFinding}
                        onCategoryFilter={onCategoryFilter}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="analytics-quality-clean-state">No configured quality issue was found in this scope.</div>
            )}

            <details className="analytics-methodology">
              <summary>How this score was calculated</summary>
              <p>{report.methodology}</p>
            </details>
          </>
        )}
      </div>
    </section>
  );
}

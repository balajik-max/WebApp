import type {
  AnalyticsSeverityBucket,
  ManholeReadinessStatus,
} from "../../lib/workflow";

interface Props {
  category: string | null;
  ward: string | null;
  severityBucket: AnalyticsSeverityBucket | null;
  readinessFieldLabel: string | null;
  readinessStatus: ManholeReadinessStatus | null;
  onClearCategory: () => void;
  onClearWard: () => void;
  onClearSeverity: () => void;
  onClearReadiness: () => void;
  onClearAll: () => void;
}

export function AnalyticsFilterChips({
  category,
  ward,
  severityBucket,
  readinessFieldLabel,
  readinessStatus,
  onClearCategory,
  onClearWard,
  onClearSeverity,
  onClearReadiness,
  onClearAll,
}: Props) {
  const activeCount =
    Number(Boolean(category)) +
    Number(Boolean(ward)) +
    Number(Boolean(severityBucket)) +
    Number(Boolean(readinessFieldLabel));
  if (activeCount === 0) return null;

  return (
    <section className="analytics-filter-chips" aria-label="Active Analytics cross-filters">
      <div>
        <b>Cross-filtered:</b>
        {category && (
          <button type="button" onClick={onClearCategory} title="Clear category cross-filter">
            Category: {category}<span aria-hidden="true">×</span>
          </button>
        )}
        {ward && (
          <button type="button" onClick={onClearWard} title="Clear ward cross-filter">
            Ward: {ward}<span aria-hidden="true">×</span>
          </button>
        )}
        {severityBucket && (
          <button type="button" onClick={onClearSeverity} title="Clear severity cross-filter">
            Severity: {severityBucket}<span aria-hidden="true">×</span>
          </button>
        )}
        {readinessFieldLabel && (
          <button type="button" onClick={onClearReadiness} title="Clear Manhole readiness view">
            {readinessFieldLabel}: {readinessStatus === "available" ? "Available" : readinessStatus === "missing" ? "Missing" : "All"}
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <button type="button" className="analytics-filter-chips__clear" onClick={onClearAll}>
        Clear cross-filters
      </button>
    </section>
  );
}

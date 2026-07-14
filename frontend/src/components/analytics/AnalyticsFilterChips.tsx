import type { AnalyticsSeverityBucket } from "../../lib/workflow";

interface Props {
  category: string | null;
  ward: string | null;
  severityBucket: AnalyticsSeverityBucket | null;
  missingFieldLabel: string | null;
  onClearCategory: () => void;
  onClearWard: () => void;
  onClearSeverity: () => void;
  onClearMissingField: () => void;
  onClearAll: () => void;
}

export function AnalyticsFilterChips({
  category,
  ward,
  severityBucket,
  missingFieldLabel,
  onClearCategory,
  onClearWard,
  onClearSeverity,
  onClearMissingField,
  onClearAll,
}: Props) {
  const activeCount =
    Number(Boolean(category)) +
    Number(Boolean(ward)) +
    Number(Boolean(severityBucket)) +
    Number(Boolean(missingFieldLabel));
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
        {missingFieldLabel && (
          <button type="button" onClick={onClearMissingField} title="Show all Manholes">
            Missing field: {missingFieldLabel}<span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <button type="button" className="analytics-filter-chips__clear" onClick={onClearAll}>
        Clear cross-filters
      </button>
    </section>
  );
}

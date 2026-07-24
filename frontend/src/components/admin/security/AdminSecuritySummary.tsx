import type { SecurityMonitoringResponse, SecurityPosture } from "../../../lib/adminSecurity";
import {
  SECURITY_POSTURE_LABEL,
  formatSecurityRelative,
} from "../../../lib/adminSecurity";

interface AdminSecuritySummaryProps {
  payload: SecurityMonitoringResponse;
  onRefresh?: () => void;
  refreshing?: boolean;
}

/**
 * Top-of-section summary for the Admin Security tab.
 *
 * Renders:
 *   - the overall posture banner (Protected / At Risk / Critical / ...)
 *   - a 4-tile grid with the headline control counts
 *   - a finding-counts strip (critical / high / medium / low / info)
 *   - the assessment timestamp + refresh button
 *
 * The posture banner uses the .sec-posture--* family in
 * admin-dashboard.css. The tile accent colors come from the same
 * helper as the Services summary.
 */
export function AdminSecuritySummary({ payload, onRefresh, refreshing = false }: AdminSecuritySummaryProps) {
  const summary = payload.summary;
  const posture: SecurityPosture = payload.overall_posture;
  const lastAssessed = formatSecurityRelative(payload.last_assessed_at);

  return (
    <section className="sec-summary" data-testid="sec-summary" data-posture={posture}>
      <header className="sec-summary__header">
        <div className="sec-summary__title-row">
          <h2 className="sec-summary__title">Security Posture</h2>
          {onRefresh && (
            <button
              type="button"
              className="sec-summary__refresh"
              onClick={onRefresh}
              disabled={refreshing}
              data-testid="sec-summary-refresh"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          )}
        </div>
        <div className={`sec-posture sec-posture--${posture}`} data-testid="sec-posture">
          {SECURITY_POSTURE_LABEL[posture]}
        </div>
        <p className="sec-summary__detail">{payload.posture_reason}</p>
        <div className="sec-summary__meta">
          {lastAssessed && (
            <span className="sec-summary__meta-item">Last assessed {lastAssessed}</span>
          )}
          <span className="sec-summary__meta-item">
            {summary.total_controls} control{summary.total_controls === 1 ? "" : "s"} assessed
          </span>
          <span className="sec-summary__meta-item">
            {summary.total_findings} open finding{summary.total_findings === 1 ? "" : "s"}
          </span>
          {payload.partial_failures.length > 0 && (
            <span className="sec-summary__meta-item sec-summary__meta-item--warn">
              {payload.partial_failures.length} partial failure
              {payload.partial_failures.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </header>

      <div className="sec-summary__tiles">
        <div className="sec-summary__tile sec-summary__tile--positive">
          <span className="sec-summary__tile-label">Protected</span>
          <span className="sec-summary__tile-value">{summary.protected}</span>
          <span className="sec-summary__tile-subtitle">Controls in place</span>
        </div>
        <div className="sec-summary__tile sec-summary__tile--warning">
          <span className="sec-summary__tile-label">At Risk / Partial</span>
          <span className="sec-summary__tile-value">
            {summary.at_risk + summary.partially_protected}
          </span>
          <span className="sec-summary__tile-subtitle">
            {summary.at_risk} at risk · {summary.partially_protected} partial
          </span>
        </div>
        <div className="sec-summary__tile sec-summary__tile--neutral">
          <span className="sec-summary__tile-label">Not Configured</span>
          <span className="sec-summary__tile-value">{summary.not_configured}</span>
          <span className="sec-summary__tile-subtitle">Not yet implemented</span>
        </div>
        <div className="sec-summary__tile sec-summary__tile--critical">
          <span className="sec-summary__tile-label">Findings</span>
          <span className="sec-summary__tile-value">
            {summary.critical_findings + summary.high_findings}
          </span>
          <span className="sec-summary__tile-subtitle">
            {summary.critical_findings} critical · {summary.high_findings} high
          </span>
        </div>
      </div>

      <div className="sec-summary__severity-strip" data-testid="sec-summary-severities">
        <div className="sec-summary__severity sec-summary__severity--critical">
          <span className="sec-summary__severity-value">{summary.critical_findings}</span>
          <span className="sec-summary__severity-label">Critical</span>
        </div>
        <div className="sec-summary__severity sec-summary__severity--high">
          <span className="sec-summary__severity-value">{summary.high_findings}</span>
          <span className="sec-summary__severity-label">High</span>
        </div>
        <div className="sec-summary__severity sec-summary__severity--medium">
          <span className="sec-summary__severity-value">{summary.medium_findings}</span>
          <span className="sec-summary__severity-label">Medium</span>
        </div>
        <div className="sec-summary__severity sec-summary__severity--low">
          <span className="sec-summary__severity-value">{summary.low_findings}</span>
          <span className="sec-summary__severity-label">Low</span>
        </div>
        <div className="sec-summary__severity sec-summary__severity--informational">
          <span className="sec-summary__severity-value">
            {summary.informational_findings}
          </span>
          <span className="sec-summary__severity-label">Info</span>
        </div>
      </div>
    </section>
  );
}

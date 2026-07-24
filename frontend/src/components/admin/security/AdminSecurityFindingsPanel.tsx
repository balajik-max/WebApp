import type { SecurityFinding, SecurityMonitoringResponse } from "../../../lib/adminSecurity";
import {
  SECURITY_SEVERITY_BADGE_CLASS,
  SECURITY_SEVERITY_LABEL,
  formatSecurityRelative,
} from "../../../lib/adminSecurity";

interface AdminSecurityFindingsPanelProps {
  payload: SecurityMonitoringResponse;
  /**
   * Click handler — when provided, each finding becomes a clickable
   * button that opens the detail drawer for the matching control
   * (matched by `id`, e.g. SEC-001 → control with key "sec_001").
   */
  onSelectFinding?: (finding: SecurityFinding) => void;
}

/**
 * "Requires Immediate Attention" panel.
 *
 * Lists every open finding with severity at or above the spec's
 * threshold (critical, high, medium). Each row is clickable when a
 * callback is provided, and carries the affected area, the summary,
 * the recommendation, and the evidence references. Never includes a
 * secret, password, or full connection string.
 */
export function AdminSecurityFindingsPanel({ payload, onSelectFinding }: AdminSecurityFindingsPanelProps) {
  const findings = payload.findings;
  const criticalAndHigh = findings.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  );
  const medium = findings.filter((f) => f.severity === "medium");
  const informational = findings.filter((f) => f.severity === "low" || f.severity === "informational");

  if (findings.length === 0) {
    return (
      <section className="sec-findings" data-testid="sec-findings-empty">
        <header className="sec-findings__header">
          <h2 className="sec-findings__title">Requires Immediate Attention</h2>
          <p className="sec-findings__subtitle">No open security findings at this time.</p>
        </header>
      </section>
    );
  }

  return (
    <section className="sec-findings" data-testid="sec-findings">
      <header className="sec-findings__header">
        <h2 className="sec-findings__title">Requires Immediate Attention</h2>
        <p className="sec-findings__subtitle">
          {findings.length} open finding{findings.length === 1 ? "" : "s"} —{" "}
          {criticalAndHigh.length} critical/high
          {medium.length > 0 ? `, ${medium.length} medium` : ""}
          {informational.length > 0 ? `, ${informational.length} low/informational` : ""}.
        </p>
      </header>

      <div className="sec-findings__list" data-testid="sec-findings-list">
        {findings.map((finding) => {
          const assessedAt = formatSecurityRelative(finding.last_assessed_at);
          const isClickable = Boolean(onSelectFinding);
          const content = (
            <>
              <div className="sec-findings__title-row">
                <span className="sec-findings__id">{finding.id}</span>
                <h3 className="sec-findings__name">{finding.title}</h3>
                <span
                  className={`sec-badge sec-badge--md ${SECURITY_SEVERITY_BADGE_CLASS[finding.severity]}`}
                >
                  {SECURITY_SEVERITY_LABEL[finding.severity]}
                </span>
              </div>
              <p className="sec-findings__affected">
                <span className="sec-findings__affected-label">Affected:</span>{" "}
                {finding.affected_area}
              </p>
              <p className="sec-findings__summary">{finding.summary}</p>
              <div className="sec-findings__recommendation">
                <span className="sec-findings__recommendation-label">Recommended action:</span>{" "}
                {finding.recommendation}
              </div>
              {finding.evidence_references.length > 0 && (
                <ul className="sec-findings__evidence">
                  {finding.evidence_references.map((ref) => (
                    <li key={ref} className="sec-findings__evidence-item">
                      {ref}
                    </li>
                  ))}
                </ul>
              )}
              <div className="sec-findings__meta">
                <span className="sec-findings__priority">
                  Priority: {finding.production_priority}
                </span>
                {assessedAt && (
                  <span className="sec-findings__time">Assessed {assessedAt}</span>
                )}
              </div>
            </>
          );

          return isClickable ? (
            <button
              key={finding.id}
              type="button"
              className="sec-findings__row sec-findings__row--clickable"
              onClick={() => onSelectFinding?.(finding)}
              data-severity={finding.severity}
              data-testid={`sec-finding-${finding.id}`}
            >
              {content}
            </button>
          ) : (
            <div
              key={finding.id}
              className="sec-findings__row"
              data-severity={finding.severity}
              data-testid={`sec-finding-${finding.id}`}
            >
              {content}
            </div>
          );
        })}
      </div>
    </section>
  );
}

import type { ServiceMonitoringResponse, ServiceMonitoringStatus } from "../../../lib/adminMonitoring";
import { formatRelative } from "../../../lib/adminMonitoring";
import { StatusBadge } from "./StatusBadge";

interface AdminServicesSummaryProps {
  payload: ServiceMonitoringResponse;
  onRefresh?: () => void;
  refreshing?: boolean;
}

/**
 * Top-of-page summary for the Services tab. Renders the overall
 * status banner, a 4-tile counter row, and the generation timestamp.
 *
 * The 4 visible tiles are:
 *   - Healthy
 *   - Attention (degraded + partial + unknown)
 *   - Outage (offline + critical)
 *   - Not Configured
 *
 * "Disabled" is collapsed into a small footnote when present so the
 * primary row stays at four tiles.
 */
export function AdminServicesSummary({ payload, onRefresh, refreshing }: AdminServicesSummaryProps) {
  const counts = payload.summary;
  const attention = counts.degraded + counts.partial + counts.unknown;
  const outage = counts.offline + counts.critical;
  const configured = counts.healthy + attention + outage + counts.not_configured;

  const generated = formatRelative(payload.generated_at);

  return (
    <section className="svc-summary" data-testid="svc-summary">
      <header className="svc-summary__header">
        <div className="svc-summary__title-row">
          <h2 className="svc-summary__title">Overall Services Status</h2>
          <StatusBadge status={payload.overall_status} size="md" />
        </div>
        {payload.overall_detail && (
          <p className="svc-summary__detail">{payload.overall_detail}</p>
        )}
        <div className="svc-summary__meta">
          {generated && (
            <span className="svc-summary__meta-item" data-testid="svc-summary-generated">
              Updated {generated}
            </span>
          )}
          <span className="svc-summary__meta-item">
            {configured} configured item{configured === 1 ? "" : "s"}
          </span>
          {onRefresh && (
            <button
              type="button"
              className="svc-summary__refresh"
              onClick={onRefresh}
              disabled={!!refreshing}
              data-testid="svc-summary-refresh"
              aria-label="Refresh services"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          )}
        </div>
      </header>

      <div className="svc-summary__tiles">
        <SummaryTile
          status="healthy"
          label="Healthy"
          value={counts.healthy}
          tone="positive"
          testid="svc-summary-healthy"
        />
        <SummaryTile
          status="degraded"
          label="Attention"
          value={attention}
          tone="warning"
          subtitle="degraded + partial + unknown"
          testid="svc-summary-attention"
        />
        <SummaryTile
          status="critical"
          label="Outage"
          value={outage}
          tone="critical"
          subtitle="offline + critical"
          testid="svc-summary-outage"
        />
        <SummaryTile
          status="not_configured"
          label="Not Configured"
          value={counts.not_configured}
          tone="neutral"
          testid="svc-summary-not-configured"
        />
      </div>

      {counts.disabled > 0 && (
        <div className="svc-summary__footnote" data-testid="svc-summary-disabled">
          {counts.disabled} disabled item{counts.disabled === 1 ? "" : "s"} hidden
        </div>
      )}
    </section>
  );
}

interface SummaryTileProps {
  status: ServiceMonitoringStatus;
  label: string;
  value: number;
  tone: "positive" | "warning" | "critical" | "neutral";
  subtitle?: string;
  testid?: string;
}

function SummaryTile({ status, label, value, tone, subtitle, testid }: SummaryTileProps) {
  return (
    <div
      className={`svc-summary__tile svc-summary__tile--${tone}`}
      data-testid={testid}
      data-status={status}
    >
      <div className="svc-summary__tile-label">{label}</div>
      <div className="svc-summary__tile-value">{value}</div>
      {subtitle && <div className="svc-summary__tile-subtitle">{subtitle}</div>}
    </div>
  );
}

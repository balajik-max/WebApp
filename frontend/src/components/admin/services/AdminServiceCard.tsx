import type { ServiceMonitoringItem } from "../../../lib/adminMonitoring";
import { formatBytes, formatRelative, formatResponseTime } from "../../../lib/adminMonitoring";
import { StatusBadge } from "./StatusBadge";

interface AdminServiceCardProps {
  item: ServiceMonitoringItem;
  children?: React.ReactNode;
  onViewDetails?: (item: ServiceMonitoringItem) => void;
}

/**
 * Full-width service card for the top-level independently-monitorable
 * services: Frontend, Backend, Database, Object Storage, Dataset
 * Processing, Storage Capacity, AI Engine.
 *
 * Card anatomy:
 *   - title row: name, status badge, criticality
 *   - one-line description
 *   - response time, last-checked timestamp, endpoint label
 *   - optional primary metric
 *   - Technical details (the item's `details` bag) — moved here from
 *     the drawer so the most useful diagnostics surface in the list
 *     view without opening the drawer
 *   - View Details action
 *
 * Capability rows (nested children) are no longer rendered inline — they
 * live in the drawer to keep the list view compact and scannable.
 */
export function AdminServiceCard({ item, onViewDetails }: AdminServiceCardProps) {
  const responseTime = formatResponseTime(item.response_time_ms);
  const lastChecked = formatRelative(item.last_checked_at);
  const details = item.details || {};

  return (
    <article
      className="svc-card"
      data-testid={`svc-card-${item.key}`}
      data-status={item.status}
      data-criticality={item.criticality}
    >
      <header className="svc-card__header">
        <div className="svc-card__title-row">
          <h3 className="svc-card__name">{item.name}</h3>
          <StatusBadge status={item.status} size="md" />
        </div>
        <div className="svc-card__sub-row">
          <span className={`svc-card__crit svc-card__crit--${item.criticality}`}>
            {item.criticality}
          </span>
          <span className="svc-card__sep">·</span>
          <span className="svc-card__kind">{item.kind.replace(/_/g, " ")}</span>
        </div>
      </header>

      <p className="svc-card__desc">{item.description}</p>

      <dl className="svc-card__meta">
        {responseTime && (
          <>
            <dt>Response</dt>
            <dd>{responseTime}</dd>
          </>
        )}
        {item.primary_metric && (
          <>
            <dt>{item.primary_metric.label}</dt>
            <dd>{item.primary_metric.value}</dd>
          </>
        )}
        {item.detail && !item.primary_metric && (
          <>
            <dt>Status</dt>
            <dd>{item.detail}</dd>
          </>
        )}
        {lastChecked && (
          <>
            <dt>Checked</dt>
            <dd>{lastChecked}</dd>
          </>
        )}
        {item.endpoint_label && (
          <>
            <dt>Endpoint</dt>
            <dd className="svc-card__endpoint">{item.endpoint_label}</dd>
          </>
        )}
      </dl>

      {Object.keys(details).length > 0 && (
        <div className="svc-card__tech-details" data-testid={`svc-card-${item.key}-tech`}>
          <div className="svc-card__tech-details-title">Technical details</div>
          <dl className="svc-card__tech-details-list">
            {Object.entries(details).map(([key, value]) => (
              <CardDetailRow key={key} k={key} v={value} />
            ))}
          </dl>
        </div>
      )}

      <footer className="svc-card__footer">
        <button
          type="button"
          className="svc-card__details"
          data-testid={`svc-card-${item.key}-details`}
          onClick={() => onViewDetails?.(item)}
        >
          View details
        </button>
      </footer>
    </article>
  );
}

function CardDetailRow({ k, v }: { k: string; v: unknown }) {
  let display: React.ReactNode;
  if (v === null || v === undefined) {
    display = "—";
  } else if (typeof v === "number") {
    if (k === "database_size_bytes") {
      display = formatBytes(v) ?? "—";
    } else {
      display = String(v);
    }
  } else if (typeof v === "boolean") {
    display = v ? "yes" : "no";
  } else if (Array.isArray(v)) {
    display = v.length ? v.join(", ") : "—";
  } else {
    display = String(v);
  }
  return (
    <>
      <dt>{k}</dt>
      <dd>{display}</dd>
    </>
  );
}

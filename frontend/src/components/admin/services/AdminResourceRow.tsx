import type { ServiceMonitoringItem } from "../../../lib/adminMonitoring";
import { StatusBadge } from "./StatusBadge";

interface AdminResourceRowProps {
  item: ServiceMonitoringItem;
}

/**
 * Compact row for resource metrics — persistent volumes, connection pool,
 * worker count, frontend build, application environment, storage capacity.
 *
 * Unlike capability rows, resource rows emphasize a single numeric or
 * named value (the "current state" of the resource) in addition to status.
 */
export function AdminResourceRow({ item }: AdminResourceRowProps) {
  const primary = item.primary_metric;
  return (
    <div className="svc-res-row" data-testid={`svc-res-${item.key}`} data-status={item.status}>
      <div className="svc-res-row__main">
        <div className="svc-res-row__name">{item.name}</div>
        {item.detail && <div className="svc-res-row__detail">{item.detail}</div>}
        {item.description && item.description !== item.detail && (
          <div className="svc-res-row__desc">{item.description}</div>
        )}
      </div>
      <div className="svc-res-row__metric">
        {primary && (
          <div className="svc-res-row__value">
            <span className="svc-res-row__value-label">{primary.label}:</span>
            <span className="svc-res-row__value-text">{primary.value}</span>
          </div>
        )}
        <StatusBadge status={item.status} />
      </div>
    </div>
  );
}

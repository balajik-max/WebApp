import type { ServiceMonitoringItem } from "../../../lib/adminMonitoring";
import { StatusBadge } from "./StatusBadge";

interface AdminCapabilityRowProps {
  item: ServiceMonitoringItem;
}

/**
 * Compact row used for internal capabilities (Authentication,
 * AI Embeddings, LAS/LAZ Processing, …). These are NOT full cards —
 * they're nested inside a parent service card or rendered under a
 * group's "capabilities" subheading.
 *
 * Renders: name, status badge, short detail, optional View Details.
 */
export function AdminCapabilityRow({ item }: AdminCapabilityRowProps) {
  return (
    <div className="svc-cap-row" data-testid={`svc-cap-${item.key}`} data-status={item.status}>
      <div className="svc-cap-row__main">
        <div className="svc-cap-row__name">{item.name}</div>
        {item.detail && <div className="svc-cap-row__detail">{item.detail}</div>}
        {item.description && item.description !== item.detail && (
          <div className="svc-cap-row__desc">{item.description}</div>
        )}
      </div>
      <div className="svc-cap-row__status">
        <StatusBadge status={item.status} />
      </div>
    </div>
  );
}

import type { ServiceMonitoringItem } from "../../../lib/adminMonitoring";
import { StatusBadge } from "./StatusBadge";

interface AdminConfigurationRowProps {
  item: ServiceMonitoringItem;
}

/**
 * Configuration-status row used for absent or intentionally
 * unavailable infrastructure — Backups, Reverse Proxy, Host CPU/RAM/GPU
 * Monitoring, Sentry, Prometheus, etc.
 *
 * Visual style is deliberately neutral / warning — never green.
 */
export function AdminConfigurationRow({ item }: AdminConfigurationRowProps) {
  return (
    <div
      className="svc-cfg-row"
      data-testid={`svc-cfg-${item.key}`}
      data-status={item.status}
    >
      <div className="svc-cfg-row__main">
        <div className="svc-cfg-row__name">{item.name}</div>
        {item.detail && <div className="svc-cfg-row__detail">{item.detail}</div>}
        {item.description && item.description !== item.detail && (
          <div className="svc-cfg-row__desc">{item.description}</div>
        )}
      </div>
      <div className="svc-cfg-row__status">
        <StatusBadge status={item.status} />
      </div>
    </div>
  );
}

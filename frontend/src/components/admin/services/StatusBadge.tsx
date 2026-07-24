import type { ServiceMonitoringStatus } from "../../../lib/adminMonitoring";
import { STATUS_LABEL } from "../../../lib/adminMonitoring";

interface StatusBadgeProps {
  status: ServiceMonitoringStatus;
  size?: "sm" | "md";
}

/**
 * Small, color-coded status badge used in service cards, group headers,
 * capability rows, and the top-of-page summary.
 *
 * The CSS class is resolved by the parent (which chooses the right
 * palette) — this component only renders the text and base styling.
 */
export function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  return (
    <span
      className={`svc-badge svc-badge--${size}`}
      data-status={status}
      data-testid={`svc-badge-${status}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

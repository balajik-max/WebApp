import type { SecurityControlStatus } from "../../../lib/adminSecurity";
import { SECURITY_STATUS_BADGE_CLASS, SECURITY_STATUS_LABEL } from "../../../lib/adminSecurity";

interface SecurityStatusBadgeProps {
  status: SecurityControlStatus;
  size?: "sm" | "md";
  /**
   * When true, render the label using the severity palette (used for
   * "at_risk" / "unknown" / "critical" so the eye picks them up at the
   * top of a list). Default false.
   */
  emphasis?: boolean;
}

/**
 * Small color-coded status badge used by every Security component.
 *
 * The CSS modifier is resolved by `SECURITY_STATUS_BADGE_CLASS`. The
 * component is intentionally minimal — it only renders the text and
 * the base `sec-badge` class, never inline styles.
 */
export function SecurityStatusBadge({ status, size = "sm", emphasis = false }: SecurityStatusBadgeProps) {
  return (
    <span
      className={`sec-badge sec-badge--${size} ${SECURITY_STATUS_BADGE_CLASS[status]}${emphasis ? " sec-badge--emph" : ""}`}
      data-status={status}
      data-testid={`sec-badge-${status}`}
    >
      {SECURITY_STATUS_LABEL[status]}
    </span>
  );
}

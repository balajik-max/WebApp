/**
 * Type definitions for the admin Security monitoring endpoint.
 *
 * The shape here mirrors `backend/app/schemas/security_monitoring.py`
 * exactly — keep both in sync. The status, severity, posture, and kind
 * enums are the single source of truth used by every Security component.
 *
 * Wire contract: GET /api/v1/admin/security
 *   - Admin only (403 for non-Admin)
 *   - Read-only, non-destructive
 *   - Never returns a secret, password, or full connection string
 */

export type SecurityControlStatus =
  | "protected"
  | "partially_protected"
  | "at_risk"
  | "unknown"
  | "not_configured"
  | "not_applicable"
  | "disabled";

export type SecuritySeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "informational";

export type SecurityPosture =
  | "protected"
  | "partially_protected"
  | "at_risk"
  | "critical"
  | "unknown";

export type SecurityControlKind = "card" | "row" | "finding" | "gap";

export type SecurityFindingStatus = "open" | "acknowledged" | "resolved";

export type SecurityProductionPriority = "immediate" | "high" | "medium" | "low";

export interface SecuritySummary {
  protected: number;
  partially_protected: number;
  at_risk: number;
  unknown: number;
  not_configured: number;
  not_applicable: number;
  disabled: number;
  critical_findings: number;
  high_findings: number;
  medium_findings: number;
  low_findings: number;
  informational_findings: number;
  total_controls: number;
  total_findings: number;
}

export interface SecurityFindingCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
}

export interface SecurityControlDetail {
  current_implementation: string | null;
  known_limitations: string | null;
  evidence_source: string | null;
  affected_components: string[];
  exposure_context: string | null;
  recommended_remediation: string | null;
  monitoring_source: string | null;
  production_impact: string | null;
  development_impact: string | null;
  extra: Record<string, unknown>;
}

export interface SecurityControl {
  key: string;
  name: string;
  kind: SecurityControlKind;
  category: string;
  status: SecurityControlStatus;
  severity: SecuritySeverity | null;
  description: string;
  scope: string | null;
  one_line: string | null;
  last_assessed_at: string | null;
  details: SecurityControlDetail;
  monitoring_source: string | null;
  display_order: number;
}

export interface SecurityFinding {
  id: string;
  title: string;
  severity: SecuritySeverity;
  status: SecurityFindingStatus;
  affected_area: string;
  summary: string;
  recommendation: string;
  evidence_references: string[];
  production_priority: SecurityProductionPriority;
  last_assessed_at: string | null;
}

export interface SecurityGroup {
  id: string;
  label: string;
  description: string;
  status: SecurityControlStatus;
  default_open: boolean;
  finding_counts: SecurityFindingCounts;
  control_counts: Record<string, number>;
  items: SecurityControl[];
}

export interface SecurityMonitoringResponse {
  generated_at: string;
  overall_posture: SecurityPosture;
  posture_reason: string;
  assessment_source: string;
  summary: SecuritySummary;
  groups: SecurityGroup[];
  findings: SecurityFinding[];
  last_assessed_at: string;
  configuration_snapshot: Record<string, unknown>;
  partial_failures: string[];
}

/**
 * Find a group by id.
 */
export function findSecurityGroup(
  payload: SecurityMonitoringResponse,
  groupId: string,
): SecurityGroup | undefined {
  return payload.groups.find((g) => g.id === groupId);
}

/**
 * Find a control anywhere in the payload by its key.
 */
export function findSecurityControl(
  payload: SecurityMonitoringResponse,
  controlKey: string,
): { control: SecurityControl; group: SecurityGroup } | null {
  for (const group of payload.groups) {
    const control = group.items.find((it) => it.key === controlKey);
    if (control) return { control, group };
  }
  return null;
}

/**
 * Find a finding by id (e.g. "SEC-001").
 */
export function findSecurityFinding(
  payload: SecurityMonitoringResponse,
  findingId: string,
): SecurityFinding | undefined {
  return payload.findings.find((f) => f.id === findingId);
}

/**
 * Map a security control status to a human label (English).
 * Used by every status badge so copy stays consistent.
 */
export const SECURITY_STATUS_LABEL: Record<SecurityControlStatus, string> = {
  protected: "Protected",
  partially_protected: "Partially Protected",
  at_risk: "At Risk",
  unknown: "Unknown",
  not_configured: "Not Configured",
  not_applicable: "Not Applicable",
  disabled: "Disabled",
};

/**
 * Map a severity to a human label.
 */
export const SECURITY_SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  informational: "Informational",
};

/**
 * Map a posture to a human label.
 */
export const SECURITY_POSTURE_LABEL: Record<SecurityPosture, string> = {
  protected: "Protected",
  partially_protected: "Partially Protected",
  at_risk: "At Risk",
  critical: "Critical",
  unknown: "Unknown",
};

/**
 * CSS modifier for per-control status badges. Aligned with
 * the .sec-badge--* family in admin-dashboard.css.
 */
export const SECURITY_STATUS_BADGE_CLASS: Record<SecurityControlStatus, string> = {
  protected: "sec-badge--protected",
  partially_protected: "sec-badge--partial",
  at_risk: "sec-badge--at-risk",
  unknown: "sec-badge--unknown",
  not_configured: "sec-badge--not-configured",
  not_applicable: "sec-badge--not-applicable",
  disabled: "sec-badge--disabled",
};

/**
 * CSS modifier for severity badges.
 */
export const SECURITY_SEVERITY_BADGE_CLASS: Record<SecuritySeverity, string> = {
  critical: "sec-badge--critical",
  high: "sec-badge--high",
  medium: "sec-badge--medium",
  low: "sec-badge--low",
  informational: "sec-badge--informational",
};

/**
 * CSS modifier for group-level status badges.
 */
export const SECURITY_GROUP_STATUS_BADGE_CLASS: Record<SecurityControlStatus, string> = {
  protected: "sec-group-badge--protected",
  partially_protected: "sec-group-badge--partial",
  at_risk: "sec-group-badge--at-risk",
  unknown: "sec-group-badge--unknown",
  not_configured: "sec-group-badge--not-configured",
  not_applicable: "sec-group-badge--not-applicable",
  disabled: "sec-group-badge--disabled",
};

/**
 * CSS modifier for posture banner.
 */
export const SECURITY_POSTURE_CLASS: Record<SecurityPosture, string> = {
  protected: "sec-posture--protected",
  partially_protected: "sec-posture--partial",
  at_risk: "sec-posture--at-risk",
  critical: "sec-posture--critical",
  unknown: "sec-posture--unknown",
};

/**
 * Format an ISO timestamp as a short relative time.
 */
export function formatSecurityRelative(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "just now";
  const secs = Math.round(diffMs / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs} seconds ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

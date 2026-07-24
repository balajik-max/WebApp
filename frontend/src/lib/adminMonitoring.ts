/**
 * Type definitions for the admin Services monitoring endpoint.
 *
 * The shape here mirrors `backend/app/schemas/service_monitoring.py`
 * exactly — keep both in sync. The status and kind enums are the single
 * source of truth used by every Services component; the backend maps any
 * legacy status tokens at the boundary so the UI never sees "ok",
 * "error", or "unavailable".
 */

export type ServiceMonitoringStatus =
  | "healthy"
  | "degraded"
  | "critical"
  | "offline"
  | "unknown"
  | "not_configured"
  | "disabled"
  | "partial";

export type ServiceMonitoringKind =
  | "service"
  | "subsystem"
  | "capability"
  | "resource"
  | "configuration"
  | "external_dependency";

export type ServiceCriticality = "critical" | "high" | "medium" | "low";

export interface ServicePrimaryMetric {
  label: string;
  value: string;
}

export interface ServiceMonitoringItem {
  key: string;
  name: string;
  kind: ServiceMonitoringKind;
  status: ServiceMonitoringStatus;
  criticality: ServiceCriticality;
  description: string;
  primary_metric: ServicePrimaryMetric | null;
  response_time_ms: number | null;
  endpoint_label: string | null;
  last_checked_at: string | null;
  detail: string | null;
  dependencies: string[];
  details: Record<string, unknown>;
  parent_key: string | null;
}

export interface ServiceMonitoringGroup {
  id: string;
  label: string;
  description: string;
  status: ServiceMonitoringStatus;
  item_count: number;
  items: ServiceMonitoringItem[];
}

export interface ServiceMonitoringSummary {
  healthy: number;
  degraded: number;
  critical: number;
  offline: number;
  unknown: number;
  not_configured: number;
  disabled: number;
  partial: number;
}

export interface ServiceMonitoringResponse {
  generated_at: string;
  overall_status: ServiceMonitoringStatus;
  overall_detail: string | null;
  summary: ServiceMonitoringSummary;
  groups: ServiceMonitoringGroup[];
  item_index: Record<string, string>;
}

/**
 * Legacy flat shape — kept here for any caller that still consumes
 * the /api/v1/admin/services/legacy endpoint. Not used by the new UI.
 */
export interface LegacyServiceProbe {
  status: "ok" | "error" | "unavailable";
  detail: string | null;
}

export interface LegacySecurityInfo {
  csrf_protection: boolean;
  rate_limit_max: number;
  rate_limit_window_seconds: number;
  failed_login_tracking: boolean;
}

export interface LegacyAdminServices {
  api: LegacyServiceProbe;
  database: LegacyServiceProbe;
  storage: LegacyServiceProbe;
  ai_engine: LegacyServiceProbe;
  disk_used_percent: number | null;
  backups: LegacyServiceProbe;
  security: LegacySecurityInfo;
}

/**
 * Find a group by id.
 */
export function findGroup(
  payload: ServiceMonitoringResponse,
  groupId: string,
): ServiceMonitoringGroup | undefined {
  return payload.groups.find((g) => g.id === groupId);
}

/**
 * Find an item anywhere in the payload by its key.
 */
export function findItem(
  payload: ServiceMonitoringResponse,
  itemKey: string,
): { item: ServiceMonitoringItem; group: ServiceMonitoringGroup } | null {
  for (const group of payload.groups) {
    const item = group.items.find((it) => it.key === itemKey);
    if (item) return { item, group };
  }
  return null;
}

/**
 * Top-level items only — filters out capability / resource rows that
 * belong to a parent card. Used by the index card list inside each group.
 */
export function topLevelItems(group: ServiceMonitoringGroup): ServiceMonitoringItem[] {
  return group.items.filter((it) => it.kind === "service" || it.kind === "subsystem");
}

/**
 * Children of a particular item key — e.g. capability rows nested under
 * the AI engine card.
 */
export function childItems(
  payload: ServiceMonitoringResponse,
  parentKey: string,
): ServiceMonitoringItem[] {
  const out: ServiceMonitoringItem[] = [];
  for (const group of payload.groups) {
    for (const item of group.items) {
      if (item.parent_key === parentKey) out.push(item);
    }
  }
  return out;
}

/**
 * Map a monitoring status to a human label (English) — used by every
 * status badge so copy stays consistent. The bilingual UI passes the
 * value through the i18n layer where possible.
 */
export const STATUS_LABEL: Record<ServiceMonitoringStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  critical: "Critical",
  offline: "Offline",
  unknown: "Unknown",
  not_configured: "Not Configured",
  disabled: "Disabled",
  partial: "Partial",
};

/**
 * CSS modifier for status badges. Keep aligned with the stylesheet
 * in admin-dashboard.css (the .svc-badge--* family).
 */
export const STATUS_BADGE_CLASS: Record<ServiceMonitoringStatus, string> = {
  healthy: "svc-badge--healthy",
  degraded: "svc-badge--degraded",
  critical: "svc-badge--critical",
  offline: "svc-badge--offline",
  unknown: "svc-badge--unknown",
  not_configured: "svc-badge--not-configured",
  disabled: "svc-badge--disabled",
  partial: "svc-badge--partial",
};

/**
 * Group-level CSS modifier — a softer palette than the per-item badges.
 */
export const GROUP_STATUS_BADGE_CLASS: Record<ServiceMonitoringStatus, string> = {
  healthy: "svc-group-badge--healthy",
  degraded: "svc-group-badge--degraded",
  critical: "svc-group-badge--critical",
  offline: "svc-group-badge--critical",
  unknown: "svc-group-badge--unknown",
  not_configured: "svc-group-badge--not-configured",
  disabled: "svc-group-badge--disabled",
  partial: "svc-group-badge--partial",
};

/**
 * Format a millisecond response time as a compact label. Anything below
 * 1ms shows as "<1 ms" so very fast probes don't render as "0 ms".
 */
export function formatResponseTime(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Format a byte count as a human-readable label.
 */
export function formatBytes(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Format an ISO timestamp as a short relative time ("20 seconds ago").
 * Mirrors the helper used elsewhere in the admin page.
 */
export function formatRelative(iso: string | null | undefined): string | null {
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

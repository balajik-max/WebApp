/**
 * Type definitions and helpers for the admin Users & Activity endpoints.
 *
 * Wire contracts:
 *   GET /api/v1/admin/activity                — dashboard summary (schemas/admin.py: AdminActivityOut)
 *   GET /api/v1/admin/users/{user_id}/activity — full per-user tracking detail (AdminUserActivityOut)
 */

export interface ActivityEntry {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  created_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

export type DeviceCategory = "desktop" | "mobile" | "tablet" | "unknown";
export type Orientation = "landscape" | "portrait";

export interface SessionEntry {
  id: string;
  user_id: string;
  user_name: string;
  user_role: string;
  ip_address: string | null;
  user_agent: string | null;
  device_category: DeviceCategory;
  screen_width: number | null;
  screen_height: number | null;
  orientation: Orientation | null;
  login_at: string;
  last_seen_at: string;
  logout_at: string | null;
  duration_minutes: number;
  is_active: boolean;
}

export interface AdminActivity {
  total_users: number;
  active_users: number;
  active_users_window_minutes: number;
  users_by_role: { role: string; count: number }[];
  recent_logins: ActivityEntry[];
  active_sessions: SessionEntry[];
  recent_sessions: SessionEntry[];
}

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: string;
}

export interface UserActivityStats {
  total_sessions: number;
  total_events: number;
  total_logins: number;
  is_online: boolean;
  current_ip: string | null;
  current_device: string | null;
  current_location: string | null;
  current_device_category: DeviceCategory | null;
  current_screen_width: number | null;
  current_screen_height: number | null;
  current_orientation: Orientation | null;
}

export interface AdminUserActivity {
  user: UserSummary;
  stats: UserActivityStats;
  sessions: SessionEntry[];
  events: ActivityEntry[];
}

export function relativeTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDuration(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hrs = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hrs < 24) return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

export const DEVICE_CATEGORY_LABEL: Record<DeviceCategory, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  tablet: "Tablet",
  unknown: "Unknown",
};

export const ORIENTATION_LABEL: Record<Orientation, string> = {
  landscape: "Landscape",
  portrait: "Portrait",
};

export function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined
): string | null {
  if (!width || !height) return null;
  return `${width} × ${height}`;
}

export function formatAbsolute(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

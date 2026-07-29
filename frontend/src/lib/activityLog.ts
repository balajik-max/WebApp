/**
 * Best-effort client-side activity logging for the admin "Full Activity /
 * Event Log" narrative (Users & Activity -> user details drawer). Mirrors
 * only a fixed, server-whitelisted subset of user interactions (see
 * backend/app/api/v1/activity.py) — never send anything here that isn't
 * one of those action names, the request is silently dropped server-side.
 */
import { apiPost } from "./api";

export type ClientActivityAction =
  | "page_viewed"
  | "map_interacted"
  | "data_layers_opened"
  | "dataset_loaded"
  | "ai_detection_selected"
  | "map_3d_viewed";

export function logActivity(
  action: ClientActivityAction,
  entityType?: string,
  payload?: Record<string, string | number | boolean | null>
): void {
  apiPost("/api/v1/activity/log", { action, entity_type: entityType ?? null, payload: payload ?? {} }).catch(() => {
    /* telemetry is best-effort — a dropped log entry must never surface to the user */
  });
}

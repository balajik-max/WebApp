/**
 * Estimated Wastewater Flow Direction — typed client for
 * GET /api/v1/wastewater-flow/manhole-flow.
 *
 * IMPORTANT: this is a candidate/estimated network derived from manhole
 * attributes and spatial proximity, never a verified underground pipe
 * layer. See FLOW_DISCLAIMER / CLOSED_ARROW_MEANING below — surface these
 * strings anywhere flow data is shown, per the feature's Phase 11/19/20
 * requirements.
 */
import { apiGet } from "./api";

export type FlowDirectionStatus =
  | "confirmed"
  | "estimated"
  | "flat_or_uncertain"
  | "unknown"
  | "conflict";

export type FlowArrowStyle = "closed" | "open" | "none";

export interface FlowSegmentProperties {
  segment_id: string;
  candidate_connection: true;
  connectivity_status: "spatially_inferred";
  dataset_id: string;
  road_cluster_id: string | null;

  from_manhole: string;
  to_manhole: string;
  upstream_manhole: string;
  downstream_manhole: string;

  road_name: string | null;

  upstream_invert_m: number | null;
  downstream_invert_m: number | null;
  elevation_difference_m: number | null;

  length_m: number | null;
  slope_ratio: number | null;
  slope_percent: number | null;

  direction_status: FlowDirectionStatus;
  /** Human-facing status label — never implies surveyed/verified physical
   * connectivity (e.g. "Direction supported by direct levels", not
   * "Confirmed"). Prefer this over DIRECTION_STATUS_LABEL when present. */
  direction_status_label?: string;
  direction_source: string;
  /** Human-facing explanation of what evidence produced this direction —
   * e.g. "Direct bottom/invert levels at both endpoints". */
  direction_evidence?: string;
  arrow_style: FlowArrowStyle;
  confidence: string;

  upstream_invert_source: string;
  downstream_invert_source: string;
  upstream_elevation_validation: string;
  downstream_elevation_validation: string;

  data_warning: string | null;
  disclaimer: string;
  closed_arrow_meaning: string;
}

export interface FlowSegmentFeature {
  type: "Feature";
  id: string;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: FlowSegmentProperties;
}

export interface FlowAnalyticsSummary {
  total_manholes: number;
  candidate_connections: number;
  confirmed_segments: number;
  derived_segments: number;
  estimated_trend_segments: number;
  unknown_segments: number;
  conflict_segments: number;
  manholes_with_direct_invert: number;
  manholes_with_derived_invert: number;
  manholes_missing_invert: number;
}

export interface FlowConfig {
  default_depth_unit: string;
  max_link_distance_m: number;
  min_link_distance_m: number;
  max_neighbours_per_manhole: number;
  depth_match_tolerance_m: number;
  depth_warning_tolerance_m: number;
  min_direction_difference_m: number;
}

export interface FlowGeoJsonResponse {
  type: "FeatureCollection";
  features: FlowSegmentFeature[];
  summary: FlowAnalyticsSummary;
  /** Counts of rejected candidate links by reason (Phase 12), for
   * debugging/auditability — not shown as raw JSON in the main UI. */
  candidate_rejections?: Record<string, number>;
  supporting_geometry_available?: { road_lines: boolean; building_polygons: boolean };
  disclaimer: string;
  closed_arrow_meaning?: string;
  config?: FlowConfig;
  message?: string;
}

export const FLOW_DISCLAIMER =
  "Flow directions are inferred from available manhole attributes and spatial relationships. " +
  "Actual underground connectivity must be verified against UGD pipe survey or as-built data.";

export const CLOSED_ARROW_MEANING =
  "Closed arrows confirm elevation-based direction for an inferred connection. " +
  "They do not confirm surveyed underground pipe connectivity.";

export interface FetchManholeFlowParams {
  datasetIds: string[];
  roadName?: string;
  directionStatus?: FlowDirectionStatus[];
  includeUnknown?: boolean;
  maxLinkDistanceM?: number;
}

export async function fetchManholeFlowDirections(
  params: FetchManholeFlowParams,
  signal?: AbortSignal
): Promise<FlowGeoJsonResponse> {
  const search = new URLSearchParams();
  for (const id of params.datasetIds) search.append("dataset_id", id);
  if (params.roadName) search.set("road_name", params.roadName);
  if (params.directionStatus) {
    for (const status of params.directionStatus) search.append("direction_status", status);
  }
  if (params.includeUnknown !== undefined) {
    search.set("include_unknown", String(params.includeUnknown));
  }
  if (params.maxLinkDistanceM !== undefined) {
    search.set("max_link_distance_m", String(params.maxLinkDistanceM));
  }
  return apiGet<FlowGeoJsonResponse>(
    `/api/v1/wastewater-flow/manhole-flow?${search.toString()}`,
    signal
  );
}

/** Formats a numeric value for display, matching the project's "Not
 * available" convention instead of surfacing undefined/null/NaN. */
export function formatFlowValue(value: number | string | null | undefined, suffix = ""): string {
  if (value === null || value === undefined) return "Not available";
  if (typeof value === "number" && !Number.isFinite(value)) return "Not available";
  return `${value}${suffix}`;
}

/** Fallback labels — never imply surveyed/verified physical connectivity.
 * Prefer FlowSegmentProperties.direction_status_label from the API when
 * present; this map only covers the case where an older cached response
 * lacks that field. */
export const DIRECTION_STATUS_LABEL: Record<FlowDirectionStatus, string> = {
  confirmed: "Direction supported by direct levels",
  estimated: "Estimated / derived",
  flat_or_uncertain: "Direction unknown",
  unknown: "Direction unknown",
  conflict: "Data conflict",
};

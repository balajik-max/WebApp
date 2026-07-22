import type { UrbanFeature } from "./types";

/**
 * Compatibility helpers for road datasets uploaded before the taxonomy was
 * split into Road_Centerline and Road_Surface. The backend performs an
 * idempotent migration at startup, but these checks keep the map usable even
 * during the first refresh after an upgrade.
 */
export const ROAD_CENTERLINE_RAW_CATEGORIES = [
  "road centerline",
  "centerline",
  "center line",
  "carriageway centerline",
  "road center line",
  "road_centerline",
  "road-centerline",
  "road_center_line",
] as const;

export const ROAD_SURFACE_RAW_CATEGORIES = [
  "concrete road",
  "concrete edge",
  "road edge",
  "carriageway",
  "asphalt road",
  "bituminous road",
  "tar road",
  "road surface",
  "concrete_road",
  "concrete-edge",
  "road_edge",
  "road_surface",
] as const;

const CENTERLINE_SET = new Set<string>(ROAD_CENTERLINE_RAW_CATEGORIES);
const SURFACE_SET = new Set<string>(ROAD_SURFACE_RAW_CATEGORIES);

export function normalizeRoadCategory(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ");
}

export function isRoadCenterlineFeature(feature: UrbanFeature): boolean {
  if (feature.properties.canonical_class === "Road_Centerline") return true;
  return CENTERLINE_SET.has(normalizeRoadCategory(feature.properties.category));
}

export function isRoadSurfaceFeature(feature: UrbanFeature): boolean {
  if (feature.properties.canonical_class === "Road_Surface") return true;
  return SURFACE_SET.has(normalizeRoadCategory(feature.properties.category));
}

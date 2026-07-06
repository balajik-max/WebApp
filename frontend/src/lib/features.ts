import { apiGet } from "./api";
import type { FeatureCollectionResponse, FeatureFilter } from "./types";

/** Compose the /api/v1/features query string from bbox + optional filters. */
export function buildFeatureQuery(
  bbox: [number, number, number, number],
  filter: FeatureFilter = {},
  limit = 2000
): string {
  const params = new URLSearchParams();
  params.set("bbox", bbox.join(","));
  params.set("limit", String(limit));
  if (filter.ward) params.set("ward", filter.ward);
  if (filter.category) params.set("category", filter.category);
  if (filter.severity !== undefined) params.set("severity", String(filter.severity));
  return `/api/v1/features?${params.toString()}`;
}

export function fetchFeaturesInViewport(
  bbox: [number, number, number, number],
  filter: FeatureFilter,
  signal: AbortSignal,
  limit = 2000
): Promise<FeatureCollectionResponse> {
  return apiGet<FeatureCollectionResponse>(buildFeatureQuery(bbox, filter, limit), signal);
}

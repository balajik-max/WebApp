import { apiGet } from "./api";
import type { FeatureCollectionResponse, FeatureFilter, UrbanFeature } from "./types";

export const VIEWPORT_FEATURE_LIMIT = 5000;

export function buildFeatureQuery(
  bbox: [number, number, number, number],
  filter: FeatureFilter = {},
  limit = VIEWPORT_FEATURE_LIMIT
): string {
  const params = new URLSearchParams();
  params.set("bbox", bbox.join(","));
  params.set("limit", String(limit));
  if (filter.datasetIds && filter.datasetIds.length > 0) {
    for (const id of filter.datasetIds) params.append("dataset_id", id);
  } else {
    if (filter.ward) params.set("ward", filter.ward);
    const categories = filter.categories?.length
      ? filter.categories
      : filter.category
        ? [filter.category]
        : [];
    for (const category of categories) params.append("category", category);
    if (filter.severity !== undefined) params.set("severity", String(filter.severity));
  }
  return `/api/v1/features?${params.toString()}`;
}

export function fetchFeaturesInViewport(
  bbox: [number, number, number, number],
  filter: FeatureFilter,
  signal: AbortSignal,
  limit = VIEWPORT_FEATURE_LIMIT
): Promise<FeatureCollectionResponse> {
  return apiGet<FeatureCollectionResponse>(buildFeatureQuery(bbox, filter, limit), signal);
}

export function fetchVisualizationLayerFeatures(
  bbox: [number, number, number, number],
  datasetId: string,
  sourceLayers: string[],
  signal: AbortSignal,
  limit = VIEWPORT_FEATURE_LIMIT
): Promise<FeatureCollectionResponse> {
  const params = new URLSearchParams();
  params.set("bbox", bbox.join(","));
  params.set("limit", String(limit));
  params.append("dataset_id", datasetId);
  for (const sourceLayer of sourceLayers) params.append("source_layer", sourceLayer);
  return apiGet<FeatureCollectionResponse>(`/api/v1/features?${params.toString()}`, signal);
}

export async function fetchFeatureById(featureId: string, signal?: AbortSignal): Promise<UrbanFeature> {
  const response = await apiGet<FeatureCollectionResponse>(
    `/api/v1/features?id=${encodeURIComponent(featureId)}&limit=1`,
    signal
  );
  const feature = response.features[0];
  if (!feature) throw new Error("The selected feature could not be found.");
  return feature;
}

export interface FidSearchResult {
  id: string;
  dataset_id: string;
  dataset_name: string;
  fid: string;
  category: string;
  label: string | null;
}

export function searchFeatureFids(
  query: string,
  options: { ward?: string; datasetIds?: string[] } = {},
  signal?: AbortSignal
): Promise<{ results: FidSearchResult[] }> {
  const params = new URLSearchParams({ q: query, limit: "20" });
  if (options.ward) params.set("ward", options.ward);
  for (const datasetId of options.datasetIds ?? []) params.append("dataset_id", datasetId);
  return apiGet<{ results: FidSearchResult[] }>(`/api/v1/features/fid-search?${params.toString()}`, signal);
}

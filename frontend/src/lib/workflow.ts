/** Analytics + workflow API helpers. */

import { apiDelete, apiGet, apiPatch, apiPost } from "./api";
import type { FeatureCollectionResponse } from "./types";

export type AnalyticsSeverityBucket = "low" | "medium" | "high";

export interface AnalyticsCrossFilters {
  wards?: string[];
  severityBuckets?: AnalyticsSeverityBucket[];
}

export interface StatusBreakdown {
  status: string;
  count: number;
}

export interface WardBreakdown {
  ward: string;
  feature_count: number;
  open_reviews: number;
  resolved_reviews: number;
}

export interface CategoryBreakdown {
  category: string;
  count: number;
  avg_severity: number;
}

export interface SeverityBucket {
  bucket: "low" | "medium" | "high";
  count: number;
}

/** One real day a dataset/feature was ingested — not a simulated point. */
export interface IngestionTrendPoint {
  date: string;
  features_added: number;
  cumulative_features: number;
}

export interface AnalyticsOverview {
  total_datasets: number;
  ready_datasets: number;
  processing_datasets: number;
  failed_datasets: number;
  total_features: number;
  average_severity: number;
  total_review_items: number;
  open_reviews: number;
  resolved_reviews: number;
  status_breakdown: StatusBreakdown[];
  ward_breakdown: WardBreakdown[];
  category_breakdown: CategoryBreakdown[];
  severity_breakdown: SeverityBucket[];
  ingestion_trend: IngestionTrendPoint[];
  generated_at: string;
}

export interface DatasetRow {
  id: string;
  name: string;
  description: string | null;
  ward: string | null;
  survey_date: string | null;
  file_type: string;
  status: string;
  storage_key: string | null;
  size_bytes: number | null;
  processing_error: string | null;
  dataset_metadata: {
    raster_overlay?: { image_key: string; bounds: [number, number, number, number] };
    [key: string]: unknown;
  };
  created_at: string;
  updated_at: string;
}

export function fetchOverview(
  datasetIds: string[] = [],
  categories: string[] = [],
  signal?: AbortSignal,
  filters: AnalyticsCrossFilters = {}
) {
  const params = analyticsScopeParams(datasetIds, categories, filters);
  const query = params.toString();
  return apiGet<AnalyticsOverview>(
    `/api/v1/analytics/overview${query ? `?${query}` : ""}`,
    signal
  );
}

export function fetchDatasets(signal?: AbortSignal, limit = 50) {
  return apiGet<DatasetRow[]>(`/api/v1/datasets?limit=${limit}`, signal);
}

export function deleteDataset(id: string, signal?: AbortSignal) {
  return apiDelete(`/api/v1/datasets/${id}`, signal);
}

export function updateDataset(id: string, body: { ward?: string | null; description?: string | null }) {
  return apiPatch<DatasetRow>(`/api/v1/datasets/${id}`, body);
}

export interface WardOption {
  ward: string;
  dataset_count: number;
  feature_count: number;
}

export function fetchWards(signal?: AbortSignal) {
  return apiGet<WardOption[]>("/api/v1/datasets/wards/list", signal);
}

export interface DatasetBounds {
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
}

export function fetchDatasetBounds(datasetId: string, signal?: AbortSignal) {
  return apiGet<DatasetBounds>(`/api/v1/datasets/${datasetId}/bounds`, signal);
}

export interface CategoryOption {
  category: string;
  count: number;
}

export function fetchCategories(
  ward: string | undefined,
  signal?: AbortSignal,
  datasetIds: string[] = []
) {
  const params = new URLSearchParams();
  if (ward) params.set("ward", ward);
  for (const id of datasetIds) params.append("dataset_id", id);
  const query = params.toString();
  return apiGet<{ categories: CategoryOption[] }>(
    `/api/v1/features/categories${query ? `?${query}` : ""}`,
    signal
  ).then((response) => response.categories);
}

export interface AnalyticsFeatureRow {
  id: string;
  dataset_id: string;
  dataset_name: string;
  ward: string | null;
  label: string | null;
  category: string;
  severity: number;
  geometry_type: string;
  created_at: string;
}

export interface AnalyticsFeaturePage {
  total: number;
  limit: number;
  offset: number;
  rows: AnalyticsFeatureRow[];
}

function analyticsScopeParams(
  datasetIds: string[],
  categories: string[],
  filters: AnalyticsCrossFilters = {}
) {
  const params = new URLSearchParams();
  for (const id of datasetIds) params.append("dataset_id", id);
  for (const category of categories) params.append("category", category);
  for (const ward of filters.wards ?? []) params.append("ward", ward);
  for (const bucket of filters.severityBuckets ?? []) params.append("severity_bucket", bucket);
  return params;
}

export function fetchAnalyticsFeatures(
  datasetIds: string[],
  categories: string[],
  signal?: AbortSignal,
  filters: AnalyticsCrossFilters = {}
) {
  const params = analyticsScopeParams(datasetIds, categories, filters);
  params.set("bbox", "-180,-90,180,90");
  params.set("limit", "5000");
  params.set("exclude_internal", "true");
  return apiGet<FeatureCollectionResponse>(`/api/v1/features?${params.toString()}`, signal);
}

export function fetchAnalyticsFeatureTable(
  datasetIds: string[],
  categories: string[],
  limit: number,
  offset: number,
  signal?: AbortSignal,
  filters: AnalyticsCrossFilters = {}
) {
  const params = analyticsScopeParams(datasetIds, categories, filters);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return apiGet<AnalyticsFeaturePage>(`/api/v1/analytics/features?${params.toString()}`, signal);
}


export interface AnalyticsQualityComponent {
  key: string;
  label: string;
  score: number;
  weight: number;
  passed: number;
  failed: number;
  explanation: string;
}

export interface AnalyticsFinding {
  id: string;
  title: string;
  description: string;
  rule: string;
  severity: "low" | "medium" | "high" | "critical";
  finding_type: "geometry" | "attribute" | "consistency" | "operational";
  affected_count: number;
  affected_percentage: number;
  priority_score: number;
  feature_ids: string[];
  category: string | null;
  attribute: string | null;
}

export interface AnalyticsQualityReport {
  total_features: number;
  overall_score: number | null;
  components: AnalyticsQualityComponent[];
  findings: AnalyticsFinding[];
  methodology: string;
  generated_at: string;
}

export function fetchAnalyticsQuality(
  datasetIds: string[],
  categories: string[],
  signal?: AbortSignal,
  filters: AnalyticsCrossFilters = {}
) {
  const params = analyticsScopeParams(datasetIds, categories, filters);
  const query = params.toString();
  return apiGet<AnalyticsQualityReport>(
    `/api/v1/analytics/quality${query ? `?${query}` : ""}`,
    signal
  );
}

export interface FeatureTableRow {
  id: string;
  fid: string | number;
  label: string | null;
  category: string | null;
  severity: number;
  attributes: Record<string, unknown>;
}

export interface FeatureTablePage {
  total: number;
  limit: number;
  offset: number;
  columns: string[];
  populated_column_count: number;
  rows: FeatureTableRow[];
}

export interface LayerFeatureTableFilter {
  category: string;
  datasetIds?: string[];
  ward?: string;
  severity?: number;
}

export function fetchDatasetFeatureTable(
  datasetId: string,
  limit: number,
  offset: number,
  signal?: AbortSignal
) {
  return apiGet<FeatureTablePage>(
    `/api/v1/datasets/${datasetId}/features?limit=${limit}&offset=${offset}`,
    signal
  );
}

export function fetchLayerFeatureTable(
  filter: LayerFeatureTableFilter,
  limit: number,
  offset: number,
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({
    category: filter.category,
    limit: String(limit),
    offset: String(offset),
  });
  filter.datasetIds?.forEach((id) => qs.append("dataset_id", id));
  if (filter.ward) qs.set("ward", filter.ward);
  if (filter.severity !== undefined) qs.set("severity", String(filter.severity));

  return apiGet<FeatureTablePage>(`/api/v1/features/table?${qs.toString()}`, signal);
}

// ---------------------- reviews / comments / versions ----------------------
export type ReviewStatus =
  | "open"
  | "reviewing"
  | "in_progress"
  | "blocked"
  | "resolved"
  | "rejected";

export interface ReviewItem {
  id: string;
  feature_id: string;
  title: string;
  description: string | null;
  priority: number;
  status: ReviewStatus;
  assigned_to: string | null;
  created_by: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommentRow {
  id: string;
  feature_id: string;
  review_item_id: string | null;
  parent_id: string | null;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface CommentWithMentions {
  comment: CommentRow;
  notified_user_ids: string[];
}

export interface FeatureVersion {
  id: string;
  feature_id: string;
  version: number;
  change_note: string | null;
  edited_by: string | null;
  attributes: Record<string, unknown>;
  created_at: string;
}

export interface ActivityRow {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export const fetchReviewsForFeature = (featureId: string, signal?: AbortSignal) =>
  apiGet<ReviewItem[]>(`/api/v1/review-items/${featureId}`, signal);

export const createReviewForFeature = (featureId: string, body: {
  title: string;
  description?: string;
  priority?: number;
  assigned_to?: string;
}) =>
  apiPost<ReviewItem>(`/api/v1/review-items/feature/${featureId}`, body);

export const updateReviewStatus = (reviewId: string, status: ReviewStatus) =>
  apiPatch<ReviewItem>(`/api/v1/review-items/${reviewId}/status`, { status });

export const listComments = (reviewId: string, signal?: AbortSignal) =>
  apiGet<CommentRow[]>(`/api/v1/review-items/${reviewId}/comments`, signal);

export const postComment = (reviewId: string, body: string) =>
  apiPost<CommentWithMentions>(`/api/v1/review-items/${reviewId}/comments`, { body });

export const listFeatureVersions = (featureId: string, signal?: AbortSignal) =>
  apiGet<FeatureVersion[]>(`/api/v1/features/${featureId}/versions`, signal);

export const uploadFeatureVersion = async (
  featureId: string,
  file: File,
  changeNote: string
): Promise<FeatureVersion> => {
  const fd = new FormData();
  fd.append("file", file);
  if (changeNote.trim()) fd.append("change_note", changeNote.trim());
  const res = await fetch(
    `${import.meta.env.VITE_API_BASE_URL ?? ""}/api/v1/features/${featureId}/versions`,
    { method: "POST", credentials: "include", body: fd }
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as FeatureVersion;
};

export const fetchFeatureActivity = (featureId: string, signal?: AbortSignal) =>
  apiGet<ActivityRow[]>(`/api/v1/features/${featureId}/activity?limit=200`, signal);

// ---------------------- survey requests -----------------------------------
export interface SurveyRequestRow {
  id: string;
  title: string;
  reason: string | null;
  ward: string | null;
  priority: number;
  status: string;
  latitude: number;
  longitude: number;
  requested_by: string | null;
  created_at: string;
  updated_at: string;
}

export const createSurveyRequest = (body: {
  title: string;
  reason?: string;
  ward?: string;
  priority?: number;
  latitude: number;
  longitude: number;
}) => apiPost<SurveyRequestRow>("/api/v1/survey-requests", body);

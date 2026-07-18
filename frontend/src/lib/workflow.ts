/** Analytics + workflow API helpers. */

import { apiDelete, apiDownload, apiGet, apiPatch, apiPost } from "./api";
import type { FeatureCollectionResponse } from "./types";

export type AnalyticsSeverityBucket = "low" | "medium" | "high";
export type SeverityVisualizationType = "bar" | "pie" | "treemap";
export type ManholeReadinessStatus = "all" | "available" | "missing";
export type ManholeReadinessFieldKey =
  | "depth"
  | "bottom_level"
  | "top_level"
  | "condition"
  | "pipe_type"
  | "diameter"
  | "image_reference";

export interface AnalyticsCrossFilters {
  wards?: string[];
  severityBuckets?: AnalyticsSeverityBucket[];
  readinessField?: ManholeReadinessFieldKey | null;
  readinessStatus?: ManholeReadinessStatus | null;
  /** Backward-compatible missing-only filter. */
  missingField?: ManholeReadinessFieldKey | null;
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
    model_assets?: {
      obj_key: string;
      obj_filename: string;
      mtl_key?: string;
      mtl_filename?: string;
      textures: Record<string, string>;
    };
    model_3d?: {
      source_crs: string;
      vertex_count?: number;
      face_count?: number;
      position_source?: string;
      is_geo_referenced?: boolean;
      asset_keys?: Record<string, string>;
    };
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
  const actualSignal = signal;
  const query = params.toString();
  return apiGet<AnalyticsOverview>(
    `/api/v1/analytics/overview${query ? `?${query}` : ""}`,
    actualSignal
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

export type VisualizationRenderer = "point" | "line" | "polygon" | "generic";
export type VisualizationFieldType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "mixed"
  | "unknown";

export interface VisualizationFieldProfile {
  name: string;
  detected_type: VisualizationFieldType;
  populated_count: number;
  missing_count: number;
  unique_count: number | null;
}

export type LayerReviewStatus = "auto" | "needs_review" | "confirmed";

export interface VisualizationLayerManifest {
  layer_key: string;
  source_layer_name: string;
  display_name: string;
  geometry_types: string[];
  feature_count: number;
  bounds: [number, number, number, number] | null;
  fields: VisualizationFieldProfile[];
  recommended_renderer: VisualizationRenderer;
  recommended_modes: string[];
  warnings: string[];
  dashboard_type: string;
  classification_confidence: number;
  classification_reasons: string[];
  review_status: LayerReviewStatus;
  included: boolean;
  ingestion_status: string;
  source_feature_count: number | null;
  ingestion_warning: string | null;
}

export interface VisualizationManifest {
  dataset_id: string;
  dataset_name: string;
  source_format: string;
  source_crs: string | null;
  display_crs: string;
  bounds: [number, number, number, number] | null;
  total_features: number;
  layers: VisualizationLayerManifest[];
  warnings: string[];
}

export function fetchVisualizationManifest(datasetId: string, signal?: AbortSignal) {
  return apiGet<VisualizationManifest>(
    `/api/v1/visualization/datasets/${datasetId}/manifest`,
    signal
  );
}

export interface LayerReviewUpdate {
  display_name?: string | null;
  dashboard_type?: string | null;
  included?: boolean | null;
  confirmed?: boolean;
}

export interface DashboardValueCount {
  label: string;
  count: number;
}

export interface DashboardNumericSummary {
  field: string;
  count: number;
  minimum: number | null;
  maximum: number | null;
  average: number | null;
}

export interface DashboardLayerSummary {
  layer_key: string;
  display_name: string;
  dashboard_type: string;
  geometry_types: string[];
  feature_count: number;
  completeness_percentage: number;
  issue_count: number;
  category_breakdown: DashboardValueCount[];
  status_field: string | null;
  status_breakdown: DashboardValueCount[];
  numeric_summaries: DashboardNumericSummary[];
  fields: VisualizationFieldProfile[];
  warnings: string[];
}

export interface UniversalDashboard {
  dataset_id: string;
  dataset_name: string;
  total_features: number;
  included_layers: number;
  point_features: number;
  line_features: number;
  polygon_features: number;
  issue_count: number;
  missing_values: number;
  profiled_values: number;
  geometry_breakdown: DashboardValueCount[];
  dashboard_types: DashboardValueCount[];
  layers: DashboardLayerSummary[];
  warnings: string[];
}

export function fetchDashboardTypes(signal?: AbortSignal) {
  return apiGet<Record<string, string>>("/api/v1/visualization/dashboard-types", signal);
}

export function updateVisualizationLayerReview(
  datasetId: string,
  layerKey: string,
  payload: LayerReviewUpdate,
  signal?: AbortSignal
) {
  return apiPatch<VisualizationManifest>(
    `/api/v1/visualization/datasets/${datasetId}/layers/${encodeURIComponent(layerKey)}`,
    payload,
    signal
  );
}

export function fetchUniversalDashboard(datasetId: string, signal?: AbortSignal) {
  return apiGet<UniversalDashboard>(
    `/api/v1/visualization/datasets/${datasetId}/dashboard`,
    signal
  );
}


export interface DashboardRecord {
  id: string;
  category: string;
  label: string | null;
  severity: number;
  geometry_type: string;
  longitude: number | null;
  latitude: number | null;
  attributes: Record<string, unknown>;
}

export interface DashboardRecordResponse {
  dataset_id: string;
  dataset_name: string;
  total: number;
  limit: number;
  truncated: boolean;
  records: DashboardRecord[];
}

export function fetchDashboardRecords(
  datasetId: string,
  signal?: AbortSignal,
  limit = 50000
) {
  return apiGet<DashboardRecordResponse>(
    `/api/v1/visualization/datasets/${datasetId}/records?limit=${limit}`,
    signal
  );
}

export function downloadUniversalDashboardExcel(datasetId: string, signal?: AbortSignal) {
  return apiDownload(
    `/api/v1/visualization/datasets/${datasetId}/export/excel`,
    signal
  );
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
  readiness_field_label?: string | null;
  readiness_status?: "available" | "missing" | null;
  readiness_value?: string | null;
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
  if (filters.readinessField) {
    params.set("readiness_field", filters.readinessField);
    params.set("readiness_status", filters.readinessStatus ?? "all");
  } else if (filters.missingField) {
    params.set("missing_field", filters.missingField);
  }
  return params;
}

export function fetchAnalyticsFeatures(
  datasetIds: string[],
  categories: string[],
  signal?: AbortSignal,
  filters: AnalyticsCrossFilters = {}
) {
  const params = analyticsScopeParams(datasetIds, categories, filters);
  params.set("limit", "5000");
  const readinessField = filters.readinessField ?? filters.missingField ?? null;
  if (readinessField) {
    const readinessStatus = filters.readinessField
      ? filters.readinessStatus ?? "all"
      : "missing";
    params.delete("category");
    params.delete("readiness_field");
    params.delete("readiness_status");
    params.delete("missing_field");
    params.set("field", readinessField);
    params.set("status", readinessStatus);
    return apiGet<FeatureCollectionResponse>(
      `/api/v1/analytics/manhole-readiness/features?${params.toString()}`,
      signal
    );
  }
  params.set("bbox", "-180,-90,180,90");
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


export interface ManholeReadinessFieldResult {
  key: ManholeReadinessFieldKey;
  label: string;
  aliases: string[];
  available_count: number;
  missing_count: number;
  completeness_percentage: number;
  recommended_action: string;
}

export interface ManholeReadinessReport {
  total_manhole_features: number;
  fields: ManholeReadinessFieldResult[];
  methodology: string;
  generated_at: string;
}

export function fetchManholeReadiness(
  datasetIds: string[],
  signal?: AbortSignal,
  filters: Pick<AnalyticsCrossFilters, "wards" | "severityBuckets"> = {}
) {
  const params = analyticsScopeParams(datasetIds, [], filters);
  const query = params.toString();
  return apiGet<ManholeReadinessReport>(
    `/api/v1/analytics/manhole-readiness${query ? `?${query}` : ""}`,
    signal
  );
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



export interface WardCensusInfo {
  ward_no: number | null;
  ward_name: string | null;
  males: number | null;
  females: number | null;
  persons: number | null;
  area_sq_km: number | null;
  population_per_sq_km: number | null;
  match_method: "exact" | "fuzzy" | "none";
  match_confidence: number;
  data_source: "live" | "cached" | "unavailable";
  source_fetched_at: string | null;
}

export interface WaterDemandLineItem {
  key: string;
  label: string;
  liters_per_day: number;
  explanation: string;
}

export interface WardWaterDemandReport {
  ward_label: string;
  census: WardCensusInfo;
  population_used: number | null;
  population_source: "census" | "manual_override" | "unavailable";
  floating_population: number;
  building_count_surveyed: number;
  total_liters_per_day: number | null;
  total_mld: number | null;
  fire_demand_liters: number | null;
  lpcd: number | null;
  lpcd_source: string | null;
  line_items: WaterDemandLineItem[];
  supply_comparison: WardSupplyComparison | null;
  methodology: string;
  generated_at: string;
}

export interface WardSupplyComparison {
  ward_demand_mld: number;
  expected_supply_mld: number;
  city_total_supply_mld: number;
  city_total_population: number;
  deficit_mld: number;
  surplus_mld: number;
  gap_mld: number;
  demand_vs_expected_supply_pct: number;
  ward_lpcd: number | null;
  expected_lpcd: number | null;
  is_deficit: boolean;
  severity: "surplus" | "mild_deficit" | "moderate_deficit" | "severe_deficit";
  note: string;
}

export interface WardWaterDemandOverrides {
  floatingPopulation?: number;
  populationOverride?: number;
  lpcdOverride?: number;
}

export function fetchWardWaterDemand(
  ward: string,
  datasetIds: string[],
  signal?: AbortSignal,
  overrides: WardWaterDemandOverrides = {}
) {
  const params = analyticsScopeParams(datasetIds, [], { wards: [ward] });
  if (overrides.floatingPopulation) params.set("floating_population", String(overrides.floatingPopulation));
  if (overrides.populationOverride != null) params.set("population_override", String(overrides.populationOverride));
  if (overrides.lpcdOverride != null) params.set("lpcd_override", String(overrides.lpcdOverride));
  const query = params.toString();
  return apiGet<WardWaterDemandReport>(
    `/api/v1/analytics/water-demand${query ? `?${query}` : ""}`,
    signal
  );
}

export type AnalyticsExportFormat = "csv" | "xlsx" | "pdf" | "geojson";

export async function downloadAnalyticsExport(
  format: AnalyticsExportFormat,
  datasetIds: string[],
  categories: string[],
  filters: AnalyticsCrossFilters = {},
  signal?: AbortSignal
) {
  const params = analyticsScopeParams(datasetIds, categories, filters);
  params.set("format", format);
  const result = await apiDownload(`/api/v1/analytics/export?${params.toString()}`, signal);
  const fallbackName = `analytics_export.${format === "xlsx" ? "xlsx" : format}`;
  const objectUrl = URL.createObjectURL(result.blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = result.filename || fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  return result.filename || fallbackName;
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

// ---------------------- AI spatial audit engine ----------------------------
export type AnomalyType = "pole_redundancy" | "drain_encroachment" | "manhole_status" | "road_width_narrowing";
export type AnomalyColor = "red" | "yellow" | "green";
export type AnomalyStatus = "open" | "reviewing" | "resolved" | "dismissed";

export interface AuditRunResult {
  dataset_id: string;
  ward: string | null;
  pole_redundancy: Record<string, number>;
  drain_encroachment: Record<string, number>;
  manhole_status: Record<string, number>;
  road_width_narrowing: Record<string, number>;
}

export interface SpatialAnomaly {
  id: string;
  dataset_id: string;
  ward: string | null;
  anomaly_type: AnomalyType;
  color: AnomalyColor;
  severity_score: number;
  status: AnomalyStatus;
  lon: number;
  lat: number;
  feature_ids: string[];
  anomaly_metadata: Record<string, unknown>;
  explanation_text: string | null;
  created_at: string;
}

export interface AnomalyExplanation {
  id: string;
  explanation_text: string;
  explanation_model: string;
  cached: boolean;
}

export const runSpatialAudit = (datasetId: string, signal?: AbortSignal) =>
  apiPost<AuditRunResult>("/api/v1/ai/audit", { dataset_id: datasetId }, signal);

export const fetchAnomalies = (datasetId: string, statusFilter?: AnomalyStatus, signal?: AbortSignal) => {
  const qs = new URLSearchParams({ dataset_id: datasetId });
  if (statusFilter) qs.set("status_filter", statusFilter);
  return apiGet<SpatialAnomaly[]>(`/api/v1/ai/audit/anomalies?${qs.toString()}`, signal);
};

export const explainAnomaly = (anomalyId: string, signal?: AbortSignal) =>
  apiPost<AnomalyExplanation>(`/api/v1/ai/audit/anomalies/${anomalyId}/explain`, {}, signal);

export const updateAnomalyStatus = (anomalyId: string, status: AnomalyStatus) =>
  apiPatch<SpatialAnomaly>(`/api/v1/ai/audit/anomalies/${anomalyId}`, { status });

// ---------------------- category -> canonical class mapping ----------------
export interface CategoryClassMapping {
  raw_category: string;
  canonical_class: string;
  match_method: "exact" | "fuzzy" | "embedding" | "manual";
  confidence: number;
}

export const fetchCanonicalClasses = (signal?: AbortSignal) =>
  apiGet<string[]>("/api/v1/classification/classes", signal);

export const fetchUnclassifiedCategories = (signal?: AbortSignal) =>
  apiGet<CategoryClassMapping[]>("/api/v1/classification/unclassified", signal);

export const fetchAllClassMappings = (signal?: AbortSignal) =>
  apiGet<CategoryClassMapping[]>("/api/v1/classification", signal);

export const assignCanonicalClass = (rawCategory: string, canonicalClass: string) =>
  apiPatch<CategoryClassMapping>(
    `/api/v1/classification/${encodeURIComponent(rawCategory)}`,
    { canonical_class: canonicalClass }
  );

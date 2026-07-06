/** Analytics + workflow API helpers. */
import { apiDelete, apiGet, apiPost } from "./api";

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

export interface AnalyticsOverview {
  total_datasets: number;
  ready_datasets: number;
  processing_datasets: number;
  failed_datasets: number;
  total_features: number;
  total_review_items: number;
  open_reviews: number;
  resolved_reviews: number;
  status_breakdown: StatusBreakdown[];
  ward_breakdown: WardBreakdown[];
  category_breakdown: CategoryBreakdown[];
  severity_breakdown: SeverityBucket[];
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
  created_at: string;
  updated_at: string;
}

export function fetchOverview(signal?: AbortSignal) {
  return apiGet<AnalyticsOverview>("/api/v1/analytics/overview", signal);
}

export function fetchDatasets(signal?: AbortSignal) {
  return apiGet<DatasetRow[]>("/api/v1/datasets?limit=50", signal);
}

export function deleteDataset(id: string, signal?: AbortSignal) {
  return apiDelete(`/api/v1/datasets/${id}`, signal);
}

export function updateDataset(id: string, body: { ward?: string | null; description?: string | null }) {
  return fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/v1/datasets/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return (await r.json()) as DatasetRow;
  });
}

export interface WardOption {
  ward: string;
  dataset_count: number;
  feature_count: number;
}

export function fetchWards(signal?: AbortSignal) {
  return apiGet<WardOption[]>("/api/v1/datasets/wards/list", signal);
}

export interface CategoryOption {
  category: string;
  count: number;
}

export function fetchCategories(ward: string | undefined, signal?: AbortSignal) {
  const qs = ward ? `?ward=${encodeURIComponent(ward)}` : "";
  return apiGet<{ categories: CategoryOption[] }>(`/api/v1/features/categories${qs}`, signal).then(
    (r) => r.categories
  );
}

export interface FeatureTableRow {
  id: string;
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
  rows: FeatureTableRow[];
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
  fetch(
    `${import.meta.env.VITE_API_BASE_URL ?? ""}/api/v1/review-items/${reviewId}/status`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ status }),
    }
  ).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return (await r.json()) as ReviewItem;
  });

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

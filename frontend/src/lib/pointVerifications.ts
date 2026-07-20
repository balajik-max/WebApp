import { apiAssetUrl, apiDownload, apiGet, apiPost, apiPostForm } from "./api";

export type PointVerificationStatus = "open" | "pending_admin" | "rejected" | "resolved";
export type AiDetectionMode = "poles" | "drains" | "manholes" | "roads";
export type AiAnomalyType = "pole_redundancy" | "drain_encroachment" | "manhole_status" | "road_width_narrowing";
export type AiIssueColor = "red" | "yellow";
export type VerifiedCondition = "bad" | "moderate" | "good";

export interface PointVerificationRecord {
  id: string | null;
  feature_id: string;
  dataset_id: string;
  dataset_name: string;
  label: string | null;
  category: string | null;
  source_layer: string | null;
  survey_condition: string | null;
  original_condition: string | null;
  verified_condition: VerifiedCondition | null;
  current_condition: string | null;
  survey_issue: boolean;
  status: PointVerificationStatus | null;
  issue_fixed: boolean | null;
  architect_id: string | null;
  architect_name: string | null;
  issue_summary: string | null;
  work_completed: string | null;
  work_started_at: string | null;
  work_completed_at: string | null;
  architect_submitted_at: string | null;
  evidence_latitude: number | null;
  evidence_longitude: number | null;
  evidence_location_source: string | null;
  evidence_location_status: string | null;
  evidence_distance_m: number | null;
  evidence_buffer_m: number | null;
  before_photo_url: string | null;
  before_photo_filename: string | null;
  before_photo_exif_latitude: number | null;
  before_photo_exif_longitude: number | null;
  before_photo_exif_captured_at: string | null;
  after_photo_url: string | null;
  after_photo_filename: string | null;
  after_photo_exif_latitude: number | null;
  after_photo_exif_longitude: number | null;
  after_photo_exif_captured_at: string | null;
  remarks: string | null;
  inspected_at: string | null;
  resolved_at: string | null;
  rejected_at: string | null;
  verified_by_id: string | null;
  verified_by_name: string | null;
  anomaly_id: string | null;
  detection_mode: AiDetectionMode | null;
  ai_anomaly_type: AiAnomalyType | null;
  ai_color: AiIssueColor | null;
  ai_severity_score: number | null;
  ai_detected_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ArchitectSubmissionInput {
  anomalyId: string;
  detectionMode: AiDetectionMode;
  issueSummary: string;
  workCompleted: string;
  workStartedAt?: string | null;
  workCompletedAt: string;
  beforePhoto: File;
  afterPhoto: File;
}

export interface AdminDecisionInput {
  anomaly_id: string;
  detection_mode: AiDetectionMode;
  decision: "approve" | "reject";
  verified_condition: VerifiedCondition;
  remarks: string;
}

export interface AiVerificationRequestContext {
  anomalyId: string;
  detectionMode: AiDetectionMode;
}

export interface RemediationInboxItem {
  verification_id: string;
  feature_id: string;
  dataset_id: string;
  dataset_name: string;
  label: string | null;
  category: string | null;
  status: PointVerificationStatus;
  detection_mode: AiDetectionMode | null;
  ai_color: AiIssueColor | null;
  architect_name: string | null;
  issue_summary: string | null;
  work_completed_at: string | null;
  architect_submitted_at: string | null;
  evidence_location_status: string | null;
  evidence_distance_m: number | null;
}

export interface RemediationUpdateItem {
  notification_id: string;
  verification_id: string | null;
  feature_id: string | null;
  dataset_id: string | null;
  dataset_name: string | null;
  label: string | null;
  category: string | null;
  source: "remediation_approved" | "remediation_rejected";
  message: string;
  admin_name: string | null;
  verified_condition: VerifiedCondition | null;
  remarks: string | null;
  status: PointVerificationStatus | null;
  created_at: string;
  read_at: string | null;
}

export function fetchPointVerification(
  featureId: string,
  ai: AiVerificationRequestContext,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    anomaly_id: ai.anomalyId,
    detection_mode: ai.detectionMode,
  });
  return apiGet<PointVerificationRecord>(
    `/api/v1/point-verifications/${encodeURIComponent(featureId)}?${query.toString()}`,
    signal,
  );
}

export function submitArchitectRemediation(featureId: string, input: ArchitectSubmissionInput) {
  const form = new FormData();
  form.append("anomaly_id", input.anomalyId);
  form.append("detection_mode", input.detectionMode);
  form.append("issue_summary", input.issueSummary);
  form.append("work_completed", input.workCompleted);
  if (input.workStartedAt) form.append("work_started_at", input.workStartedAt);
  form.append("work_completed_at", input.workCompletedAt);
  form.append("before_photo", input.beforePhoto);
  form.append("after_photo", input.afterPhoto);
  return apiPostForm<PointVerificationRecord>(
    `/api/v1/point-verifications/${encodeURIComponent(featureId)}/architect-submit`,
    form,
  );
}

export function submitAdminDecision(featureId: string, payload: AdminDecisionInput) {
  return apiPost<PointVerificationRecord>(
    `/api/v1/point-verifications/${encodeURIComponent(featureId)}/admin-decision`,
    payload,
  );
}

export function fetchRemediationInbox(signal?: AbortSignal) {
  return apiGet<RemediationInboxItem[]>(
    "/api/v1/point-verifications/inbox?status_filter=pending_admin",
    signal,
  );
}

export function fetchRemediationUpdates(signal?: AbortSignal) {
  return apiGet<RemediationUpdateItem[]>("/api/v1/point-verifications/updates", signal);
}

export function markRemediationUpdateRead(notificationId: string) {
  return apiPost<{ ok: boolean }>(
    `/api/v1/point-verifications/updates/${encodeURIComponent(notificationId)}/read`,
    {},
  );
}

export function remediationEvidenceUrl(path: string | null): string | null {
  return path ? apiAssetUrl(path) : null;
}

export function downloadPointVerificationExcel(datasetId?: string) {
  const query = datasetId ? `?dataset_id=${encodeURIComponent(datasetId)}` : "";
  return apiDownload(`/api/v1/point-verifications/export.xlsx${query}`);
}

export function downloadResolvedGdb(datasetId: string) {
  return apiDownload(
    `/api/v1/point-verifications/export-resolved-gdb?dataset_id=${encodeURIComponent(datasetId)}`,
  );
}

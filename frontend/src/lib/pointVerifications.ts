import { apiAssetUrl, apiDownload, apiGet, apiPost, apiPutForm } from "./api";

export type WorkflowStatus =
  | "AI_DETECTED"
  | "WORK_IN_PROGRESS"
  | "PENDING_COMMISSIONER_APPROVAL"
  | "REJECTED_BY_COMMISSIONER"
  | "APPROVED_RESOLVED";
export type AiDetectionMode = "poles" | "drains" | "manholes";
export type AiAnomalyType = "pole_redundancy" | "drain_encroachment" | "manhole_status";
export type AiIssueColor = "red" | "yellow";

export interface WorkflowHistoryItem {
  event: string;
  version: number;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  occurred_at: string;
  details: Record<string, unknown>;
  before_photo_url: string | null;
  after_photo_url: string | null;
}

export interface PointVerificationRecord {
  id: string | null;
  feature_id: string;
  dataset_id: string;
  dataset_name: string;
  label: string | null;
  asset_type: string | null;
  source_layer: string | null;
  original_gdb_attributes: Record<string, unknown>;
  original_gdb_condition: string | null;
  original_ai_condition: string | null;
  current_condition: string | null;
  workflow_status: WorkflowStatus;
  field_submitter_id: string | null;
  field_submitter_name: string | null;
  field_submitter_role: string | null;
  work_started_at: string | null;
  submitted_at: string | null;
  issue_solved: boolean;
  short_description: string | null;
  remarks: string | null;
  gps_validation_status: string | null;
  photo_latitude: number | null;
  photo_longitude: number | null;
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
  commissioner_decision: "APPROVE" | "REJECT" | null;
  commissioner_id: string | null;
  commissioner_name: string | null;
  commissioner_decided_at: string | null;
  commissioner_remarks: string | null;
  anomaly_id: string | null;
  detection_mode: AiDetectionMode | null;
  ai_anomaly_type: AiAnomalyType | null;
  ai_color: AiIssueColor | null;
  ai_severity_score: number | null;
  ai_detected_at: string | null;
  submission_version: number;
  history: WorkflowHistoryItem[];
  created_at: string | null;
  updated_at: string | null;
}

export interface AiVerificationRequestContext {
  anomalyId: string;
  detectionMode: AiDetectionMode;
}

export interface FieldSubmissionInput extends AiVerificationRequestContext {
  issueSolved: boolean;
  shortDescription: string;
  remarks?: string | null;
}

export interface CommissionerDecisionInput extends AiVerificationRequestContext {
  decision: "APPROVE" | "REJECT";
  reason?: string | null;
}

export interface RemediationInboxItem {
  verification_id: string;
  feature_id: string;
  dataset_id: string;
  dataset_name: string;
  label: string | null;
  asset_type: string | null;
  source_layer: string | null;
  anomaly_id: string;
  workflow_status: WorkflowStatus;
  detection_mode: AiDetectionMode | null;
  ai_anomaly_type: AiAnomalyType | null;
  ai_color: AiIssueColor | null;
  ai_severity_score: number | null;
  ai_detected_at: string | null;
  longitude: number;
  latitude: number;
  field_submitter_name: string | null;
  field_submitter_role: string | null;
  short_description: string | null;
  submitted_at: string | null;
  gps_validation_status: string | null;
  evidence_distance_m: number | null;
}

export interface RemediationUpdateItem {
  notification_id: string;
  verification_id: string | null;
  feature_id: string | null;
  dataset_id: string | null;
  dataset_name: string | null;
  label: string | null;
  asset_type: string | null;
  anomaly_id: string | null;
  detection_mode: AiDetectionMode | null;
  ai_anomaly_type: AiAnomalyType | null;
  ai_color: AiIssueColor | null;
  ai_severity_score: number | null;
  ai_detected_at: string | null;
  longitude: number | null;
  latitude: number | null;
  source: "remediation_approved" | "remediation_rejected";
  message: string;
  commissioner_name: string | null;
  commissioner_remarks: string | null;
  workflow_status: WorkflowStatus | null;
  created_at: string;
  read_at: string | null;
}

function workflowQuery(ai: AiVerificationRequestContext): string {
  return new URLSearchParams({
    anomaly_id: ai.anomalyId,
    detection_mode: ai.detectionMode,
  }).toString();
}

export function fetchPointVerification(
  featureId: string,
  ai: AiVerificationRequestContext,
  signal?: AbortSignal,
) {
  return apiGet<PointVerificationRecord>(
    `/api/v1/point-verifications/${encodeURIComponent(featureId)}/workflow?${workflowQuery(ai)}`,
    signal,
  );
}

export function startRemediationWork(featureId: string, ai: AiVerificationRequestContext) {
  return apiPost<PointVerificationRecord>(
    `/api/v1/point-verifications/${encodeURIComponent(featureId)}/start-work`,
    { anomaly_id: ai.anomalyId, detection_mode: ai.detectionMode },
  );
}

export function uploadRemediationEvidence(
  featureId: string,
  ai: AiVerificationRequestContext,
  beforeImage: File,
  afterImage: File,
) {
  const form = new FormData();
  form.append("anomaly_id", ai.anomalyId);
  form.append("detection_mode", ai.detectionMode);
  form.append("before_image", beforeImage);
  form.append("after_image", afterImage);
  return apiPutForm<PointVerificationRecord>(
    `/api/v1/point-verifications/${encodeURIComponent(featureId)}/evidence`,
    form,
  );
}

export function submitFieldRemediation(featureId: string, input: FieldSubmissionInput) {
  return apiPost<PointVerificationRecord>(
    `/api/v1/point-verifications/${encodeURIComponent(featureId)}/submit`,
    {
      anomaly_id: input.anomalyId,
      detection_mode: input.detectionMode,
      issue_solved: input.issueSolved,
      short_description: input.shortDescription,
      remarks: input.remarks || null,
    },
  );
}

export function submitCommissionerDecision(featureId: string, input: CommissionerDecisionInput) {
  return apiPost<PointVerificationRecord>(
    `/api/v1/point-verifications/${encodeURIComponent(featureId)}/commissioner-decision`,
    {
      anomaly_id: input.anomalyId,
      decision: input.decision,
      reason: input.reason || null,
    },
  );
}

export function fetchRemediationInbox(signal?: AbortSignal) {
  return apiGet<RemediationInboxItem[]>("/api/v1/point-verifications/inbox", signal);
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

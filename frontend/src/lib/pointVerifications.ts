import { apiAssetUrl, apiDownload, apiGet, apiPost, apiPutForm } from "./api";

export type WorkflowStatus =
  | "AI_DETECTED"
  | "WORK_IN_PROGRESS"
  | "PENDING_AEE_APPROVAL"
  | "RETURNED_BY_AEE"
  | "AEE_APPROVED"
  | "COMMISSIONER_ACCEPTED";
export type AiDetectionMode = "poles" | "drains" | "manholes";
export type AiAnomalyType = "pole_redundancy" | "drain_encroachment" | "manhole_status";
export type AiIssueColor = "red" | "yellow";
export type AeeCategory = "GOOD" | "MODERATE" | "BAD";

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
  field_submitter_account_name: string | null;
  field_submitter_role: string | null;
  ae_name: string | null;
  work_started_at: string | null;
  submitted_at: string | null;
  issue_solved: boolean;
  issue_description: string | null;
  work_completed: string | null;
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
  aee_id: string | null;
  aee_account_name: string | null;
  aee_name: string | null;
  aee_category: AeeCategory | null;
  aee_decided_at: string | null;
  aee_remarks: string | null;
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
  aeName: string;
  issueDescription: string;
  workCompleted: string;
  remarks?: string | null;
}

export interface AeeDecisionInput extends AiVerificationRequestContext {
  aeeName: string;
  category: AeeCategory;
  remarks?: string | null;
}

export interface CommissionerAcceptanceInput extends AiVerificationRequestContext {
  remarks?: string | null;
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
  ae_name: string | null;
  aee_name: string | null;
  aee_category: AeeCategory | null;
  issue_description: string | null;
  work_completed: string | null;
  submitted_at: string | null;
  aee_decided_at: string | null;
  gps_validation_status: string | null;
  evidence_distance_m: number | null;
}

export type RemediationNotificationSource =
  | "remediation_submitted"
  | "remediation_aee_approved"
  | "remediation_returned"
  | "remediation_commissioner_accepted";

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
  source: RemediationNotificationSource;
  message: string;
  actor_name: string | null;
  ae_name: string | null;
  aee_name: string | null;
  aee_category: AeeCategory | null;
  issue_description: string | null;
  work_completed: string | null;
  ae_remarks: string | null;
  aee_remarks: string | null;
  commissioner_remarks: string | null;
  before_photo_url: string | null;
  after_photo_url: string | null;
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

export function fetchPointVerification(featureId: string, ai: AiVerificationRequestContext, signal?: AbortSignal) {
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
      ae_name: input.aeName,
      issue_description: input.issueDescription,
      work_completed: input.workCompleted,
      remarks: input.remarks || null,
    },
  );
}

export function submitAeeDecision(featureId: string, input: AeeDecisionInput) {
  return apiPost<PointVerificationRecord>(
    `/api/v1/point-verifications/${encodeURIComponent(featureId)}/aee-decision`,
    {
      anomaly_id: input.anomalyId,
      aee_name: input.aeeName,
      category: input.category,
      remarks: input.remarks || null,
    },
  );
}

export function submitCommissionerAcceptance(featureId: string, input: CommissionerAcceptanceInput) {
  return apiPost<PointVerificationRecord>(
    `/api/v1/point-verifications/${encodeURIComponent(featureId)}/commissioner-accept`,
    { anomaly_id: input.anomalyId, remarks: input.remarks || null },
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

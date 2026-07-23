"""Contracts for AE field work, AEE review, Commissioner acceptance, and notifications."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.models.point_verification import RemediationWorkflowStatus

DetectionMode = Literal["poles", "drains", "manholes", "potholes", "standing_water"]
AiAnomalyType = Literal[
    "pole_redundancy",
    "drain_encroachment",
    "manhole_status",
    "pothole_status",
    "standing_water_status",
]
AiIssueColor = Literal["red", "yellow"]
AeeCategory = Literal["GOOD", "MODERATE", "BAD"]


class StartWorkIn(BaseModel):
    anomaly_id: uuid.UUID
    detection_mode: DetectionMode


class FieldSubmissionIn(BaseModel):
    anomaly_id: uuid.UUID
    detection_mode: DetectionMode
    ae_name: str = Field(min_length=2, max_length=255)
    issue_description: str = Field(min_length=3, max_length=4096)
    work_completed: str = Field(min_length=3, max_length=2048)
    remarks: str | None = Field(default=None, max_length=4096)


class AeeDecisionIn(BaseModel):
    anomaly_id: uuid.UUID
    aee_name: str = Field(min_length=2, max_length=255)
    category: AeeCategory
    remarks: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def require_return_reason(self) -> "AeeDecisionIn":
        if self.category in {"MODERATE", "BAD"} and not (self.remarks or "").strip():
            raise ValueError("AEE remarks are required for Moderate or Bad work")
        return self


class CommissionerAcceptanceIn(BaseModel):
    anomaly_id: uuid.UUID
    remarks: str | None = Field(default=None, max_length=4096)


class WorkflowHistoryItem(BaseModel):
    event: str
    version: int = 0
    actor_id: uuid.UUID | None = None
    actor_name: str | None = None
    actor_role: str | None = None
    occurred_at: datetime
    details: dict = Field(default_factory=dict)
    before_photo_url: str | None = None
    after_photo_url: str | None = None


class WorkflowOut(BaseModel):
    id: uuid.UUID | None = None
    feature_id: uuid.UUID
    dataset_id: uuid.UUID
    dataset_name: str
    label: str | None = None
    asset_type: str | None = None
    source_layer: str | None = None
    original_gdb_attributes: dict = Field(default_factory=dict)
    original_gdb_condition: str | None = None
    original_ai_condition: str | None = None
    current_condition: str | None = None
    workflow_status: RemediationWorkflowStatus

    field_submitter_id: uuid.UUID | None = None
    field_submitter_account_name: str | None = None
    field_submitter_role: str | None = None
    ae_name: str | None = None
    work_started_at: datetime | None = None
    submitted_at: datetime | None = None
    issue_solved: bool = False
    issue_description: str | None = None
    work_completed: str | None = None
    remarks: str | None = None

    gps_validation_status: str | None = None
    photo_latitude: float | None = None
    photo_longitude: float | None = None
    evidence_distance_m: float | None = None
    evidence_buffer_m: float | None = None
    before_photo_url: str | None = None
    before_photo_filename: str | None = None
    before_photo_exif_latitude: float | None = None
    before_photo_exif_longitude: float | None = None
    before_photo_exif_captured_at: datetime | None = None
    after_photo_url: str | None = None
    after_photo_filename: str | None = None
    after_photo_exif_latitude: float | None = None
    after_photo_exif_longitude: float | None = None
    after_photo_exif_captured_at: datetime | None = None

    aee_id: uuid.UUID | None = None
    aee_account_name: str | None = None
    aee_name: str | None = None
    aee_category: AeeCategory | None = None
    aee_decided_at: datetime | None = None
    aee_remarks: str | None = None

    commissioner_id: uuid.UUID | None = None
    commissioner_name: str | None = None
    commissioner_decided_at: datetime | None = None
    commissioner_remarks: str | None = None

    anomaly_id: uuid.UUID | None = None
    detection_mode: DetectionMode | None = None
    ai_anomaly_type: AiAnomalyType | None = None
    ai_color: AiIssueColor | None = None
    ai_severity_score: float | None = None
    ai_detected_at: datetime | None = None
    longitude: float | None = None
    latitude: float | None = None
    submission_version: int = 0
    history: list[WorkflowHistoryItem] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class WorkflowDashboardItem(BaseModel):
    """Backend-persistent summary used by the AE Tasks and AEE Activity dashboards."""

    verification_id: uuid.UUID
    feature_id: uuid.UUID
    dataset_id: uuid.UUID
    dataset_name: str
    label: str | None = None
    asset_type: str | None = None
    source_layer: str | None = None
    anomaly_id: uuid.UUID | None = None
    workflow_status: RemediationWorkflowStatus
    detection_mode: DetectionMode | None = None
    ai_anomaly_type: AiAnomalyType | None = None
    ai_color: AiIssueColor | None = None
    ai_severity_score: float | None = None
    ai_detected_at: datetime | None = None
    longitude: float | None = None
    latitude: float | None = None
    ae_name: str | None = None
    aee_name: str | None = None
    aee_category: AeeCategory | None = None
    issue_description: str | None = None
    work_completed: str | None = None
    ae_remarks: str | None = None
    aee_remarks: str | None = None
    commissioner_remarks: str | None = None
    submitted_at: datetime | None = None
    aee_decided_at: datetime | None = None
    commissioner_decided_at: datetime | None = None
    gps_validation_status: str | None = None
    evidence_distance_m: float | None = None
    before_photo_url: str | None = None
    after_photo_url: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class RemediationInboxItem(BaseModel):
    verification_id: uuid.UUID
    feature_id: uuid.UUID
    dataset_id: uuid.UUID
    dataset_name: str
    label: str | None = None
    asset_type: str | None = None
    source_layer: str | None = None
    anomaly_id: uuid.UUID
    workflow_status: RemediationWorkflowStatus
    detection_mode: DetectionMode | None = None
    ai_anomaly_type: AiAnomalyType | None = None
    ai_color: AiIssueColor | None = None
    ai_severity_score: float | None = None
    ai_detected_at: datetime | None = None
    longitude: float
    latitude: float
    ae_name: str | None = None
    aee_name: str | None = None
    aee_category: AeeCategory | None = None
    issue_description: str | None = None
    work_completed: str | None = None
    submitted_at: datetime | None = None
    aee_decided_at: datetime | None = None
    gps_validation_status: str | None = None
    evidence_distance_m: float | None = None


NotificationKind = Literal[
    "remediation_submitted",
    "remediation_aee_approved",
    "remediation_returned",
    "remediation_commissioner_accepted",
    "remediation_approved",
    "remediation_rejected",
]


class RemediationUpdateItem(BaseModel):
    notification_id: uuid.UUID
    verification_id: uuid.UUID | None = None
    feature_id: uuid.UUID | None = None
    dataset_id: uuid.UUID | None = None
    dataset_name: str | None = None
    label: str | None = None
    asset_type: str | None = None
    anomaly_id: uuid.UUID | None = None
    detection_mode: DetectionMode | None = None
    ai_anomaly_type: AiAnomalyType | None = None
    ai_color: AiIssueColor | None = None
    ai_severity_score: float | None = None
    ai_detected_at: datetime | None = None
    longitude: float | None = None
    latitude: float | None = None
    source: NotificationKind
    message: str
    actor_name: str | None = None
    ae_name: str | None = None
    aee_name: str | None = None
    aee_category: AeeCategory | None = None
    issue_description: str | None = None
    work_completed: str | None = None
    ae_remarks: str | None = None
    aee_remarks: str | None = None
    commissioner_remarks: str | None = None
    before_photo_url: str | None = None
    after_photo_url: str | None = None
    workflow_status: RemediationWorkflowStatus | None = None
    created_at: datetime
    read_at: datetime | None = None

# ---------------------------------------------------------------------------
# Legacy Architect -> Admin remediation contracts
# ---------------------------------------------------------------------------
# These endpoints and schemas are intentionally retained so the colleague's
# existing Architect/Admin remediation remains available alongside the new
# AE -> AEE -> Commissioner workflow. The old Tasks/Activity assignment UI is
# not part of this compatibility surface.
from app.models.point_verification import PointVerificationStatus, VerifiedCondition

LegacyAdminDecision = Literal["approve", "reject"]


class LegacyAdminDecisionIn(BaseModel):
    anomaly_id: uuid.UUID
    detection_mode: DetectionMode
    decision: LegacyAdminDecision
    verified_condition: VerifiedCondition
    remarks: str = Field(min_length=1, max_length=4096)

    @model_validator(mode="after")
    def validate_condition_for_decision(self) -> "LegacyAdminDecisionIn":
        if self.decision == "approve" and self.verified_condition != VerifiedCondition.GOOD:
            raise ValueError("Admin approval requires Verified Condition = Good")
        if self.decision == "reject" and self.verified_condition == VerifiedCondition.GOOD:
            raise ValueError("A Good condition must be approved, not rejected")
        return self


class LegacyPointVerificationOut(BaseModel):
    id: uuid.UUID | None = None
    feature_id: uuid.UUID
    dataset_id: uuid.UUID
    dataset_name: str
    label: str | None = None
    category: str | None = None
    source_layer: str | None = None
    survey_condition: str | None = None
    original_condition: str | None = None
    verified_condition: VerifiedCondition | None = None
    current_condition: str | None = None
    survey_issue: bool
    status: PointVerificationStatus | None = None
    issue_fixed: bool | None = None

    architect_id: uuid.UUID | None = None
    architect_name: str | None = None
    issue_summary: str | None = None
    work_completed: str | None = None
    work_started_at: datetime | None = None
    work_completed_at: datetime | None = None
    architect_submitted_at: datetime | None = None

    evidence_latitude: float | None = None
    evidence_longitude: float | None = None
    evidence_location_source: str | None = None
    evidence_location_status: str | None = None
    evidence_distance_m: float | None = None
    evidence_buffer_m: float | None = None

    before_photo_url: str | None = None
    before_photo_filename: str | None = None
    before_photo_exif_latitude: float | None = None
    before_photo_exif_longitude: float | None = None
    before_photo_exif_captured_at: datetime | None = None
    after_photo_url: str | None = None
    after_photo_filename: str | None = None
    after_photo_exif_latitude: float | None = None
    after_photo_exif_longitude: float | None = None
    after_photo_exif_captured_at: datetime | None = None

    remarks: str | None = None
    inspected_at: datetime | None = None
    resolved_at: datetime | None = None
    rejected_at: datetime | None = None
    verified_by_id: uuid.UUID | None = None
    verified_by_name: str | None = None

    anomaly_id: uuid.UUID | None = None
    detection_mode: DetectionMode | None = None
    ai_anomaly_type: AiAnomalyType | None = None
    ai_color: AiIssueColor | None = None
    ai_severity_score: float | None = None
    ai_detected_at: datetime | None = None
    longitude: float | None = None
    latitude: float | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

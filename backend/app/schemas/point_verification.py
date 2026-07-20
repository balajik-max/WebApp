"""Contracts for direct AE/AEE remediation and Commissioner decisions."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.models.point_verification import RemediationWorkflowStatus

DetectionMode = Literal["poles", "drains", "manholes"]
AiAnomalyType = Literal["pole_redundancy", "drain_encroachment", "manhole_status"]
AiIssueColor = Literal["red", "yellow"]
CommissionerDecision = Literal["APPROVE", "REJECT"]


class StartWorkIn(BaseModel):
    anomaly_id: uuid.UUID
    detection_mode: DetectionMode


class FieldSubmissionIn(BaseModel):
    anomaly_id: uuid.UUID
    detection_mode: DetectionMode
    issue_solved: bool
    short_description: str = Field(min_length=3, max_length=2048)
    remarks: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def require_solved(self) -> "FieldSubmissionIn":
        if not self.issue_solved:
            raise ValueError("Issue Solved / Work Performed must be confirmed")
        return self


class CommissionerDecisionIn(BaseModel):
    anomaly_id: uuid.UUID
    decision: CommissionerDecision
    reason: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def require_rejection_reason(self) -> "CommissionerDecisionIn":
        if self.decision == "REJECT" and not (self.reason or "").strip():
            raise ValueError("A rejection reason is required")
        return self


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
    field_submitter_name: str | None = None
    field_submitter_role: str | None = None
    work_started_at: datetime | None = None
    submitted_at: datetime | None = None
    issue_solved: bool = False
    short_description: str | None = None
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

    commissioner_decision: CommissionerDecision | None = None
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
    submission_version: int = 0
    history: list[WorkflowHistoryItem] = Field(default_factory=list)
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
    field_submitter_name: str | None = None
    field_submitter_role: str | None = None
    short_description: str | None = None
    submitted_at: datetime | None = None
    gps_validation_status: str | None = None
    evidence_distance_m: float | None = None


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
    source: Literal["remediation_approved", "remediation_rejected"]
    message: str
    commissioner_name: str | None = None
    commissioner_remarks: str | None = None
    workflow_status: RemediationWorkflowStatus | None = None
    created_at: datetime
    read_at: datetime | None = None

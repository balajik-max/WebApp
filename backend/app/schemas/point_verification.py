"""Schemas for Architect remediation evidence and Admin approval."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.models.point_verification import PointVerificationStatus, VerifiedCondition

DetectionMode = Literal["poles", "drains", "manholes"]
AiAnomalyType = Literal["pole_redundancy", "drain_encroachment", "manhole_status"]
AiIssueColor = Literal["red", "yellow"]
AdminDecision = Literal["approve", "reject"]


class AdminDecisionIn(BaseModel):
    anomaly_id: uuid.UUID
    detection_mode: DetectionMode
    decision: AdminDecision
    verified_condition: VerifiedCondition
    remarks: str = Field(min_length=1, max_length=4096)

    @model_validator(mode="after")
    def validate_condition_for_decision(self) -> "AdminDecisionIn":
        if self.decision == "approve" and self.verified_condition != VerifiedCondition.GOOD:
            raise ValueError("Admin approval requires Verified Condition = Good")
        if self.decision == "reject" and self.verified_condition == VerifiedCondition.GOOD:
            raise ValueError("A Good condition must be approved, not rejected")
        return self


class PointVerificationOut(BaseModel):
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
    created_at: datetime | None = None
    updated_at: datetime | None = None


class RemediationInboxItem(BaseModel):
    verification_id: uuid.UUID
    feature_id: uuid.UUID
    dataset_id: uuid.UUID
    dataset_name: str
    label: str | None = None
    category: str | None = None
    status: PointVerificationStatus
    detection_mode: DetectionMode | None = None
    ai_color: AiIssueColor | None = None
    architect_name: str | None = None
    issue_summary: str | None = None
    work_completed_at: datetime | None = None
    architect_submitted_at: datetime | None = None
    evidence_location_status: str | None = None
    evidence_distance_m: float | None = None


class RemediationUpdateItem(BaseModel):
    notification_id: uuid.UUID
    verification_id: uuid.UUID | None = None
    feature_id: uuid.UUID | None = None
    dataset_id: uuid.UUID | None = None
    dataset_name: str | None = None
    label: str | None = None
    category: str | None = None
    source: Literal["remediation_approved", "remediation_rejected"]
    message: str
    admin_name: str | None = None
    verified_condition: VerifiedCondition | None = None
    remarks: str | None = None
    status: PointVerificationStatus | None = None
    created_at: datetime
    read_at: datetime | None = None

"""AE field remediation, AEE review, Commissioner acceptance, and read-only MLA visibility."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum as SAEnum, Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class PointVerificationStatus(str, enum.Enum):
    OPEN = "open"
    PENDING_ADMIN = "pending_admin"
    REJECTED = "rejected"
    RESOLVED = "resolved"


class RemediationWorkflowStatus(str, enum.Enum):
    AI_DETECTED = "AI_DETECTED"
    WORK_IN_PROGRESS = "WORK_IN_PROGRESS"
    PENDING_AEE_APPROVAL = "PENDING_AEE_APPROVAL"
    RETURNED_BY_AEE = "RETURNED_BY_AEE"
    AEE_APPROVED = "AEE_APPROVED"
    COMMISSIONER_ACCEPTED = "COMMISSIONER_ACCEPTED"


class VerifiedCondition(str, enum.Enum):
    BAD = "bad"
    MODERATE = "moderate"
    GOOD = "good"


class PointVerification(Base):
    __tablename__ = "point_verifications"

    id: Mapped[uuid.UUID] = uuid_pk()
    feature_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("features.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Deprecated compatibility column. A plain string prevents older staged
    # status values from causing ORM enum-decoding failures. New workflow
    # APIs never use this field for authorization or transitions.
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default=PointVerificationStatus.OPEN.name,
        index=True,
    )
    issue_fixed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    workflow_status: Mapped[RemediationWorkflowStatus] = mapped_column(
        SAEnum(RemediationWorkflowStatus, name="remediation_workflow_status", native_enum=False, length=48),
        nullable=False,
        default=RemediationWorkflowStatus.AI_DETECTED,
        index=True,
    )
    field_submitter_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    field_submitter_role: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ae_name_manual: Mapped[str | None] = mapped_column(String(255), nullable=True)
    issue_solved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    issue_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    short_description: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    field_remarks: Mapped[str | None] = mapped_column(Text, nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    aee_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    aee_name_manual: Mapped[str | None] = mapped_column(String(255), nullable=True)
    aee_category: Mapped[str | None] = mapped_column(String(16), nullable=True)
    aee_decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    aee_remarks: Mapped[str | None] = mapped_column(Text, nullable=True)
    commissioner_decision: Mapped[str | None] = mapped_column(String(16), nullable=True)
    commissioner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    commissioner_decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    commissioner_remarks: Mapped[str | None] = mapped_column(Text, nullable=True)
    original_ai_condition: Mapped[str | None] = mapped_column(String(16), nullable=True)
    current_condition: Mapped[str | None] = mapped_column(String(16), nullable=True)
    gps_validation_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    submission_version: Mapped[int] = mapped_column(nullable=False, default=0)
    workflow_history: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)

    # Deprecated condition mirrors retained for historical compatibility.
    original_condition: Mapped[str | None] = mapped_column(String(128), nullable=True)
    verified_condition: Mapped[VerifiedCondition | None] = mapped_column(
        SAEnum(VerifiedCondition, name="verified_condition", native_enum=False, length=32),
        nullable=True,
    )

    # Deprecated legacy submission mirrors. They remain readable for
    # historical integrations but are never written by the new workflow.
    architect_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    issue_summary: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    work_completed: Mapped[str | None] = mapped_column(Text, nullable=True)
    work_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    work_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    architect_submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Validated work location extracted only from photo EXIF.
    evidence_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    evidence_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    evidence_location_source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    evidence_location_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    evidence_distance_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    evidence_buffer_m: Mapped[float | None] = mapped_column(Float, nullable=True)

    before_photo_key: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    before_photo_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    before_photo_content_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    before_photo_exif_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    before_photo_exif_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    before_photo_exif_captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    after_photo_key: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    after_photo_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    after_photo_content_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    after_photo_exif_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    after_photo_exif_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    after_photo_exif_captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Deprecated legacy decision mirrors retained for historical rows.
    remarks: Mapped[str | None] = mapped_column(Text, nullable=True)
    inspected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    verified_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Snapshot of the exact AI finding that made this feature eligible.
    anomaly_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    detection_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    ai_anomaly_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ai_color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    ai_severity_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    ai_detected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

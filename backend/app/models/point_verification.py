"""Architect remediation evidence and Admin approval for AI-detected issues."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum as SAEnum, Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class PointVerificationStatus(str, enum.Enum):
    OPEN = "open"
    PENDING_ADMIN = "pending_admin"
    REJECTED = "rejected"
    RESOLVED = "resolved"


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
    status: Mapped[PointVerificationStatus] = mapped_column(
        SAEnum(PointVerificationStatus, name="point_verification_status", native_enum=False, length=32),
        nullable=False,
        default=PointVerificationStatus.OPEN,
        index=True,
    )
    issue_fixed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Immutable condition snapshot plus the Admin's latest assessment.
    original_condition: Mapped[str | None] = mapped_column(String(128), nullable=True)
    verified_condition: Mapped[VerifiedCondition | None] = mapped_column(
        SAEnum(VerifiedCondition, name="verified_condition", native_enum=False, length=32),
        nullable=True,
    )

    # Architect remediation submission.
    architect_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    issue_summary: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    work_completed: Mapped[str | None] = mapped_column(Text, nullable=True)
    work_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    work_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    architect_submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # One validated work location. It may come from manual entry or photo EXIF.
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

    # Admin review. These fields are intentionally nullable until a decision is made.
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

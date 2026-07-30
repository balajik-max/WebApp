"""Public/citizen portal models.

These tables are intentionally separate from the officer ``users`` and
``user_sessions`` tables so public registration and complaint workflows cannot
change or weaken the existing AE/AEE/Commissioner/MLA/Admin authentication
boundary.
"""
from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, Date, DateTime, Enum as SAEnum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from geoalchemy2 import Geometry

from app.db.base import Base
from app.models.dataset import DatasetFileType, DatasetStatus
from app.models._mixins import created_at_col, updated_at_col, utcnow, uuid_pk


class PublicOtpPurpose(str, enum.Enum):
    REGISTER = "register"


class PublicComplaintStatus(str, enum.Enum):
    SUBMITTED = "submitted"
    RECEIVED = "received"
    VIEWED_BY_COMMISSIONER = "viewed_by_commissioner"
    IN_REVIEW = "in_review"
    RESOLVED = "resolved"


class PublicNotificationKind(str, enum.Enum):
    COMPLAINT_SUBMITTED = "complaint_submitted"
    COMMISSIONER_VIEWED = "commissioner_viewed"
    STATUS_CHANGED = "status_changed"


class PublicUser(Base):
    __tablename__ = "public_users"

    id: Mapped[uuid.UUID] = uuid_pk()
    first_name: Mapped[str] = mapped_column(String(120), nullable=False)
    last_name: Mapped[str] = mapped_column(String(120), nullable=False)
    date_of_birth: Mapped[date] = mapped_column(Date, nullable=False)
    phone: Mapped[str] = mapped_column(String(20), nullable=False, unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True, unique=True, index=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    phone_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    registration_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    registration_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    registration_accuracy_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    registration_location_label: Mapped[str | None] = mapped_column(String(500), nullable=True)
    registration_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    registration_user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    complaints = relationship(
        "PublicComplaint",
        back_populates="public_user",
        cascade="all, delete-orphan",
        lazy="raise",
    )
    notifications = relationship(
        "PublicNotification",
        back_populates="public_user",
        cascade="all, delete-orphan",
        lazy="raise",
    )
    datasets = relationship(
        "PublicDataset",
        back_populates="public_user",
        cascade="all, delete-orphan",
        lazy="raise",
    )


class PublicOtpChallenge(Base):
    __tablename__ = "public_otp_challenges"

    id: Mapped[uuid.UUID] = uuid_pk()
    phone: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True, index=True)
    purpose: Mapped[PublicOtpPurpose] = mapped_column(
        SAEnum(PublicOtpPurpose, name="public_otp_purpose", native_enum=False, length=32),
        nullable=False,
        default=PublicOtpPurpose.REGISTER,
    )
    code_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    registration_token_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    registration_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    request_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = created_at_col()


class PublicSession(Base):
    __tablename__ = "public_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    public_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("public_users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
    screen_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    screen_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    login_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    logout_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PublicDataset(Base):
    """Citizen-owned geospatial upload isolated from officer datasets."""

    __tablename__ = "public_datasets"

    id: Mapped[uuid.UUID] = uuid_pk()
    public_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("public_users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    file_type: Mapped[DatasetFileType] = mapped_column(
        SAEnum(DatasetFileType, name="public_dataset_file_type", native_enum=False, length=32),
        nullable=False,
    )
    storage_key: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    status: Mapped[DatasetStatus] = mapped_column(
        SAEnum(DatasetStatus, name="public_dataset_status", native_enum=False, length=32),
        nullable=False,
        default=DatasetStatus.UPLOADED,
        index=True,
    )
    processing_error: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    dataset_metadata: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    public_user = relationship("PublicUser", back_populates="datasets", lazy="joined")
    features = relationship(
        "PublicDatasetFeature",
        back_populates="dataset",
        cascade="all, delete-orphan",
        lazy="raise",
    )


class PublicDatasetFeature(Base):
    """Map-ready feature rows belonging only to a citizen dataset."""

    __tablename__ = "public_dataset_features"

    id: Mapped[uuid.UUID] = uuid_pk()
    public_dataset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("public_datasets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    geom = mapped_column(
        Geometry(geometry_type="GEOMETRY", srid=4326, spatial_index=False),
        nullable=False,
    )
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    category: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    attributes: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = created_at_col()

    dataset = relationship("PublicDataset", back_populates="features", lazy="joined")


class PublicComplaint(Base):
    __tablename__ = "public_complaints"

    id: Mapped[uuid.UUID] = uuid_pk()
    public_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("public_users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[PublicComplaintStatus] = mapped_column(
        SAEnum(PublicComplaintStatus, name="public_complaint_status", native_enum=False, length=48),
        nullable=False,
        default=PublicComplaintStatus.SUBMITTED,
        index=True,
    )

    image_key: Mapped[str] = mapped_column(String(700), nullable=False)
    image_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    image_content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    image_exif_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    image_exif_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    image_captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    location_accuracy_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    location_label: Mapped[str | None] = mapped_column(String(500), nullable=True)
    location_source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    submitted_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    submitted_user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)

    commissioner_viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    commissioner_viewed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    public_user = relationship("PublicUser", back_populates="complaints", lazy="joined")
    notifications = relationship(
        "PublicNotification",
        back_populates="complaint",
        cascade="all, delete-orphan",
        lazy="raise",
    )


class PublicNotification(Base):
    __tablename__ = "public_notifications"

    id: Mapped[uuid.UUID] = uuid_pk()
    public_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("public_users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    complaint_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("public_complaints.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    kind: Mapped[PublicNotificationKind] = mapped_column(
        SAEnum(PublicNotificationKind, name="public_notification_kind", native_enum=False, length=48),
        nullable=False,
    )
    message: Mapped[str] = mapped_column(String(1024), nullable=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = created_at_col()

    public_user = relationship("PublicUser", back_populates="notifications", lazy="joined")
    complaint = relationship("PublicComplaint", back_populates="notifications", lazy="joined")

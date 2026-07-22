"""datasets table — uploaded survey inputs with processing status."""
from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import Date, Enum as SAEnum, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class DatasetStatus(str, enum.Enum):
    UPLOADED = "uploaded"
    QUEUED = "queued"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class DatasetFileType(str, enum.Enum):
    GEOJSON = "geojson"
    SHAPEFILE = "shapefile"
    KML = "kml"
    CSV = "csv"
    GEOTIFF = "geotiff"
    LAS = "las"
    LIDAR = "lidar"
    IMAGE = "image"
    OTHER = "other"


class Dataset(Base):
    __tablename__ = "datasets"

    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    survey_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    ward: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)

    file_type: Mapped[DatasetFileType] = mapped_column(
        SAEnum(DatasetFileType, name="dataset_file_type", native_enum=False, length=32),
        nullable=False,
    )
    storage_key: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[DatasetStatus] = mapped_column(
        SAEnum(DatasetStatus, name="dataset_status", native_enum=False, length=32),
        default=DatasetStatus.UPLOADED,
        nullable=False,
        index=True,
    )
    processing_error: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    dataset_metadata: Mapped[dict] = mapped_column(
        "metadata", JSONB, nullable=False, default=dict
    )

    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    uploader = relationship("User", back_populates="datasets", lazy="joined")
    features = relationship(
        "Feature", back_populates="dataset", cascade="all, delete-orphan", lazy="raise"
    )
    placemarks = relationship("Placemark", back_populates="dataset", lazy="raise")

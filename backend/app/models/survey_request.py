"""survey_requests table — architects ask for a fresh survey team visit."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from geoalchemy2 import Geometry
from sqlalchemy import Enum as SAEnum, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class SurveyRequestStatus(str, enum.Enum):
    REQUESTED = "requested"
    SCHEDULED = "scheduled"
    IN_FIELD = "in_field"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class SurveyRequest(Base):
    __tablename__ = "survey_requests"

    id: Mapped[uuid.UUID] = uuid_pk()
    requested_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    ward: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    priority: Mapped[int] = mapped_column(Integer, default=2, nullable=False)

    # Native geographic POINT (SRID 4326) — location a survey team should visit.
    location = mapped_column(
        Geometry(geometry_type="POINT", srid=4326, spatial_index=True),
        nullable=False,
    )

    status: Mapped[SurveyRequestStatus] = mapped_column(
        SAEnum(SurveyRequestStatus, name="survey_request_status", native_enum=False, length=32),
        default=SurveyRequestStatus.REQUESTED,
        nullable=False,
        index=True,
    )

    scheduled_at: Mapped[datetime | None] = mapped_column(nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(nullable=True)

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    requester = relationship("User", lazy="joined", foreign_keys=[requested_by])

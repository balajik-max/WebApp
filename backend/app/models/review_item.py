"""review_items table — architect workflow with SLA delta timestamps."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Enum as SAEnum, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class ReviewStatus(str, enum.Enum):
    OPEN = "open"
    REVIEWING = "reviewing"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    RESOLVED = "resolved"
    REJECTED = "rejected"


class ReviewPriority(int, enum.Enum):
    P0 = 0  # critical / must-fix immediately
    P1 = 1
    P2 = 2
    P3 = 3
    P4 = 4  # nice-to-have


class ReviewItem(Base):
    __tablename__ = "review_items"

    id: Mapped[uuid.UUID] = uuid_pk()
    feature_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("features.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(4096), nullable=True)

    priority: Mapped[ReviewPriority] = mapped_column(
        Integer, default=int(ReviewPriority.P2), nullable=False, index=True
    )
    status: Mapped[ReviewStatus] = mapped_column(
        SAEnum(ReviewStatus, name="review_status", native_enum=False, length=32),
        default=ReviewStatus.OPEN,
        nullable=False,
        index=True,
    )

    assigned_to: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # Delta timestamps used to compute SLA metrics.
    first_response_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    feature = relationship("Feature", back_populates="review_items", lazy="joined")

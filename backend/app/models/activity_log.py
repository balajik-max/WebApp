"""activity_log table — immutable audit trail."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Enum as SAEnum, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._mixins import created_at_col, uuid_pk


class ActivityAction(str, enum.Enum):
    # Coarse-grained action verbs.  Fine-grained context lives in `payload`.
    LOGIN = "login"
    LOGOUT = "logout"
    USER_CREATED = "user_created"

    DATASET_UPLOADED = "dataset_uploaded"
    DATASET_STATUS_CHANGED = "dataset_status_changed"
    DATASET_DELETED = "dataset_deleted"

    FEATURE_CREATED = "feature_created"
    FEATURE_UPDATED = "feature_updated"
    FEATURE_VERSIONED = "feature_versioned"

    REVIEW_ASSIGNED = "review_assigned"
    REVIEW_STATUS_CHANGED = "review_status_changed"
    COMMENT_POSTED = "comment_posted"

    SURVEY_REQUESTED = "survey_requested"
    SURVEY_STATUS_CHANGED = "survey_status_changed"

    PLACEMARK_CREATED = "placemark_created"
    PLACEMARK_UPDATED = "placemark_updated"
    PLACEMARK_DELETED = "placemark_deleted"


class ActivityLog(Base):
    __tablename__ = "activity_log"

    id: Mapped[uuid.UUID] = uuid_pk()

    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    action: Mapped[ActivityAction] = mapped_column(
        SAEnum(ActivityAction, name="activity_action", native_enum=False, length=64),
        nullable=False,
        index=True,
    )
    entity_type: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)

    # Rich context (before/after diffs, IPs, HTTP request IDs, etc.).
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    created_at: Mapped[datetime] = created_at_col()

    actor = relationship("User", back_populates="activity_logs", lazy="joined")

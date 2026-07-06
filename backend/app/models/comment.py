"""comments table — threaded review discussions."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, backref, mapped_column, relationship

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[uuid.UUID] = uuid_pk()
    feature_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("features.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    review_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("review_items.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("comments.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    author_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    body: Mapped[str] = mapped_column(String(4096), nullable=False)

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    author = relationship("User", back_populates="comments", lazy="joined")
    feature = relationship("Feature", back_populates="comments", lazy="joined")
    replies = relationship(
        "Comment",
        cascade="all, delete-orphan",
        backref=backref("parent", remote_side=[id]),
        lazy="raise",
    )

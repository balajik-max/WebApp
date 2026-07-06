"""feature_versions table — architectural design version history."""
from __future__ import annotations

import uuid
from datetime import datetime

from geoalchemy2 import Geometry
from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._mixins import created_at_col, uuid_pk


class FeatureVersion(Base):
    __tablename__ = "feature_versions"
    __table_args__ = (
        UniqueConstraint("feature_id", "version", name="uq_feature_version"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    feature_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("features.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)

    # Snapshot of the geometry + attributes at that version.
    geom = mapped_column(
        Geometry(geometry_type="GEOMETRY", srid=4326, spatial_index=False),
        nullable=False,
    )
    attributes: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    change_note: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    edited_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = created_at_col()

    feature = relationship("Feature", back_populates="versions", lazy="joined")

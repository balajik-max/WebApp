"""
features table — PostGIS-backed spatial features.

Uses GEOMETRY(GEOMETRY, 4326) so the same table can hold points, lines and
polygons produced by different survey pipelines.  A GIST index named
`idx_features_geom` is created separately in init_db to satisfy the spec.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from geoalchemy2 import Geometry
from sqlalchemy import Float, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class Feature(Base):
    __tablename__ = "features"

    id: Mapped[uuid.UUID] = uuid_pk()
    dataset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("datasets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Human-friendly label and analytical category.
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    category: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)

    # Severity metric (0.0 – 1.0) used to rank items for review.
    severity: Mapped[float] = mapped_column(Float, nullable=False, default=0.0, index=True)

    # Raw metadata rows from the ingested file are preserved here.
    attributes: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    # PostGIS geometry column — accepts any geometry type at SRID 4326.
    # spatial_index=False because we create the named GIST index manually.
    geom = mapped_column(
        Geometry(geometry_type="GEOMETRY", srid=4326, spatial_index=False),
        nullable=False,
    )

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    dataset = relationship("Dataset", back_populates="features", lazy="joined")
    review_items = relationship(
        "ReviewItem", back_populates="feature", cascade="all, delete-orphan", lazy="raise"
    )
    versions = relationship(
        "FeatureVersion",
        back_populates="feature",
        cascade="all, delete-orphan",
        order_by="FeatureVersion.version.desc()",
        lazy="raise",
    )
    comments = relationship(
        "Comment", back_populates="feature", cascade="all, delete-orphan", lazy="raise"
    )

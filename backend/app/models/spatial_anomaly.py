"""spatial_anomalies table — persisted findings from the AI spatial audit
engine (pole redundancy clustering, building/drain encroachment, manhole
status). One shared table across all three detection goals; `anomaly_type`
distinguishes them and `metadata` carries the type-specific facts.

All spatial math that PRODUCES these rows lives in app.services.spatial_audit
as deterministic PostGIS/Python computation — this table only stores results.
The AI (Ollama) only ever narrates the `metadata` already computed here; it
never reasons about geometry itself.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from geoalchemy2 import Geometry
from sqlalchemy import Enum as SAEnum, Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class AnomalyType(str, enum.Enum):
    POLE_REDUNDANCY = "pole_redundancy"
    DRAIN_ENCROACHMENT = "drain_encroachment"
    MANHOLE_STATUS = "manhole_status"


class AnomalyColor(str, enum.Enum):
    RED = "red"
    YELLOW = "yellow"
    GREEN = "green"


class AnomalyStatus(str, enum.Enum):
    OPEN = "open"
    REVIEWING = "reviewing"
    RESOLVED = "resolved"
    DISMISSED = "dismissed"


class SpatialAnomaly(Base):
    __tablename__ = "spatial_anomalies"

    id: Mapped[uuid.UUID] = uuid_pk()
    dataset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("datasets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    ward: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)

    anomaly_type: Mapped[AnomalyType] = mapped_column(
        SAEnum(AnomalyType, name="anomaly_type", native_enum=False, length=32),
        nullable=False,
        index=True,
    )
    color: Mapped[AnomalyColor] = mapped_column(
        SAEnum(AnomalyColor, name="anomaly_color", native_enum=False, length=16),
        nullable=False,
        index=True,
    )
    severity_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    status: Mapped[AnomalyStatus] = mapped_column(
        SAEnum(AnomalyStatus, name="anomaly_status", native_enum=False, length=16),
        default=AnomalyStatus.OPEN,
        nullable=False,
        index=True,
    )

    # Representative point (cluster centroid / building centroid / manhole
    # point) — always a POINT regardless of the contributing features' own
    # geometry types, so the map layer can render every anomaly uniformly.
    geom = mapped_column(
        Geometry(geometry_type="POINT", srid=4326, spatial_index=False),
        nullable=False,
    )

    feature_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), nullable=False, default=list)

    # The verified numbers behind the finding (distances, overlap %, drain
    # status, neighbor labels) — the ONLY thing the LLM is ever shown when
    # asked to explain this anomaly. Never invented, always computed here.
    anomaly_metadata: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    explanation_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    explanation_model: Mapped[str | None] = mapped_column(String(64), nullable=True)

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

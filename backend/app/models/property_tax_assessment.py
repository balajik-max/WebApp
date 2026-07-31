"""Property-tax assessment records linked to surveyed GIS buildings.

The raw survey attributes remain immutable in ``features.attributes``. This
model stores the municipal interpretation, workflow status, and a frozen GIS
snapshot used when the draft assessment was last saved.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class PropertyTaxAssessmentStatus(str, enum.Enum):
    NOT_ASSESSED = "not_assessed"
    DRAFT = "draft"
    VERIFICATION_PENDING = "verification_pending"
    VERIFIED = "verified"
    APPROVED = "approved"
    DEMAND_GENERATED = "demand_generated"


class PropertyTaxAssessment(Base):
    __tablename__ = "property_tax_assessments"
    __table_args__ = (
        UniqueConstraint("feature_id", name="uq_property_tax_assessments_feature_id"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    feature_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("features.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    dataset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("datasets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    status: Mapped[PropertyTaxAssessmentStatus] = mapped_column(
        String(32),
        nullable=False,
        default=PropertyTaxAssessmentStatus.NOT_ASSESSED.value,
        index=True,
    )

    property_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    assessment_number: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    owner_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    occupancy_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    construction_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tax_zone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    municipal_use: Mapped[str | None] = mapped_column(String(64), nullable=True)

    municipal_plot_area_sqm: Mapped[float | None] = mapped_column(Float, nullable=True)
    municipal_built_up_area_sqm: Mapped[float | None] = mapped_column(Float, nullable=True)
    municipal_floor_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    municipal_record_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("property_tax_municipal_records.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    financial_year: Mapped[str] = mapped_column(String(16), nullable=False, default="2026-27")
    discrepancy_status: Mapped[str] = mapped_column(String(32), nullable=False, default="not_reviewed")
    floor_assessments: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)

    annual_rate_per_sqm: Mapped[float | None] = mapped_column(Float, nullable=True)
    usage_factor: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    zone_factor: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    construction_factor: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    age_factor: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    cess_percent: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    service_charge: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    rebate_amount: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    exemption_amount: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    base_annual_tax: Mapped[float | None] = mapped_column(Float, nullable=True)
    estimated_annual_tax: Mapped[float | None] = mapped_column(Float, nullable=True)

    remarks: Mapped[str | None] = mapped_column(Text, nullable=True)
    gis_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

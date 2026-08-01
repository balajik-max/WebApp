"""Annual property-tax demands generated from approved assessments."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class PropertyTaxDemand(Base):
    __tablename__ = "property_tax_demands"
    __table_args__ = (
        UniqueConstraint("assessment_id", "financial_year", name="uq_property_tax_demand_assessment_year"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    assessment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_tax_assessments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    feature_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("features.id", ondelete="CASCADE"), nullable=False, index=True
    )
    dataset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    generated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    financial_year: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    demand_number: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="generated", index=True)
    base_tax: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    cess_amount: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    service_charge: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    rebate_amount: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    exemption_amount: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    total_demand: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    calculation_breakdown: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

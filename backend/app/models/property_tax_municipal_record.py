"""Official municipal property-register rows linked to surveyed GIS buildings.

Records are imported from CSV/XLSX exports.  Raw source values are preserved in
``raw_record`` while normalized fields power search, matching and assessment.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class PropertyTaxMunicipalRecord(Base):
    __tablename__ = "property_tax_municipal_records"

    id: Mapped[uuid.UUID] = uuid_pk()
    dataset_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("datasets.id", ondelete="CASCADE"), nullable=True, index=True
    )
    feature_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("features.id", ondelete="SET NULL"), nullable=True, unique=True, index=True
    )
    imported_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    linked_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    property_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    assessment_number: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    sas_number: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    door_number: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    owner_name: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    owner_mobile: Mapped[str | None] = mapped_column(String(32), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)

    municipal_use: Mapped[str | None] = mapped_column(String(64), nullable=True)
    occupancy_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    construction_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tax_zone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    municipal_plot_area_sqm: Mapped[float | None] = mapped_column(Float, nullable=True)
    municipal_built_up_area_sqm: Mapped[float | None] = mapped_column(Float, nullable=True)
    municipal_floor_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    annual_rate_per_sqm: Mapped[float | None] = mapped_column(Float, nullable=True)
    financial_year: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    source_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)

    source_name: Mapped[str] = mapped_column(String(255), nullable=False)
    source_row_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    match_method: Mapped[str | None] = mapped_column(String(64), nullable=True)
    match_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    raw_record: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    linked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

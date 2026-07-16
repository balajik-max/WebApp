"""Cache/fallback tables for the Davanagere City Corporation census pages.

Population is resolved live on every ward-water-demand request (see
`app.services.analytics.ward_census`). These tables exist only so a request
still has a usable number when the source site is slow or down: every
successful live fetch upserts here, and a failed fetch falls back to
whatever was last stored.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._mixins import uuid_pk


class WardCensus(Base):
    __tablename__ = "ward_census"

    id: Mapped[uuid.UUID] = uuid_pk()
    ward_no: Mapped[int] = mapped_column(Integer, nullable=False, unique=True, index=True)
    ward_name: Mapped[str] = mapped_column(String(255), nullable=False)
    males: Mapped[int | None] = mapped_column(Integer, nullable=True)
    females: Mapped[int | None] = mapped_column(Integer, nullable=True)
    persons: Mapped[int] = mapped_column(Integer, nullable=False)
    area_sq_km: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CityCensusSummary(Base):
    """Singleton row (one city). Identified by `id = 1`, not a UUID."""

    __tablename__ = "city_census_summary"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    total_population: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_area_sq_km: Mapped[float | None] = mapped_column(Float, nullable=True)
    number_of_wards: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_water_supply_mld: Mapped[float | None] = mapped_column(Float, nullable=True)
    per_capita_supply_lpcd: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

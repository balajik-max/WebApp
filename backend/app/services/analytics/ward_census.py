"""Resolve a survey ward tag to a live (or last-cached) census row.

`Dataset.ward` is free text typed at upload time (see
`app.api.v1.datasets.upload`), while the Corporation's own census table uses
its own ward names. The two rarely match exactly, so resolution always
reports *how* it matched — exact, fuzzy, or not at all — instead of silently
picking a ward and risking a wrong population being reported to a client.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from difflib import SequenceMatcher
import re
from typing import Literal

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CityCensusSummary, WardCensus
from app.models._mixins import utcnow
from app.services.analytics.ward_census_source import (
    CityCensusSummaryData,
    WardCensusRow,
    fetch_live,
)

DataSource = Literal["live", "cached", "unavailable"]
MatchMethod = Literal["exact", "fuzzy", "none"]

_FUZZY_MATCH_THRESHOLD = 0.6


@dataclass(frozen=True, slots=True)
class WardCensusResolution:
    data_source: DataSource
    source_fetched_at: datetime | None
    matched: WardCensusRow | None
    match_method: MatchMethod
    match_confidence: float
    city_summary: CityCensusSummaryData | None


def _normalize(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", name.casefold()).strip()


def _best_match(ward_label: str, rows: list[WardCensusRow]) -> tuple[WardCensusRow | None, MatchMethod, float]:
    if not rows:
        return None, "none", 0.0
    normalized_label = _normalize(ward_label)

    for row in rows:
        if _normalize(row.ward_name) == normalized_label:
            return row, "exact", 1.0

    best_row: WardCensusRow | None = None
    best_ratio = 0.0
    for row in rows:
        ratio = SequenceMatcher(None, normalized_label, _normalize(row.ward_name)).ratio()
        if ratio > best_ratio:
            best_row, best_ratio = row, ratio

    if best_row is not None and best_ratio >= _FUZZY_MATCH_THRESHOLD:
        return best_row, "fuzzy", round(best_ratio, 3)
    return None, "none", round(best_ratio, 3)


async def _upsert_cache(
    db: AsyncSession,
    rows: list[WardCensusRow],
    summary: CityCensusSummaryData | None,
    fetched_at: datetime,
) -> None:
    for row in rows:
        stmt = pg_insert(WardCensus).values(
            ward_no=row.ward_no,
            ward_name=row.ward_name,
            males=row.males,
            females=row.females,
            persons=row.persons,
            area_sq_km=row.area_sq_km,
            source_fetched_at=fetched_at,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[WardCensus.ward_no],
            set_={
                "ward_name": stmt.excluded.ward_name,
                "males": stmt.excluded.males,
                "females": stmt.excluded.females,
                "persons": stmt.excluded.persons,
                "area_sq_km": stmt.excluded.area_sq_km,
                "source_fetched_at": stmt.excluded.source_fetched_at,
            },
        )
        await db.execute(stmt)

    if summary is not None:
        stmt = pg_insert(CityCensusSummary).values(
            id=1,
            total_population=summary.total_population,
            total_area_sq_km=summary.total_area_sq_km,
            number_of_wards=summary.number_of_wards,
            total_water_supply_mld=summary.total_water_supply_mld,
            per_capita_supply_lpcd=summary.per_capita_supply_lpcd,
            source_fetched_at=fetched_at,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[CityCensusSummary.id],
            set_={
                "total_population": stmt.excluded.total_population,
                "total_area_sq_km": stmt.excluded.total_area_sq_km,
                "number_of_wards": stmt.excluded.number_of_wards,
                "total_water_supply_mld": stmt.excluded.total_water_supply_mld,
                "per_capita_supply_lpcd": stmt.excluded.per_capita_supply_lpcd,
                "source_fetched_at": stmt.excluded.source_fetched_at,
            },
        )
        await db.execute(stmt)


async def _read_cache(db: AsyncSession) -> tuple[list[WardCensusRow], CityCensusSummaryData | None, datetime | None]:
    result = await db.execute(select(WardCensus).order_by(WardCensus.ward_no))
    cached_rows = [
        WardCensusRow(
            ward_no=r.ward_no,
            ward_name=r.ward_name,
            males=r.males,
            females=r.females,
            persons=r.persons,
            area_sq_km=r.area_sq_km,
        )
        for r in result.scalars().all()
    ]
    fetched_at: datetime | None = None
    if cached_rows:
        fetched_at = (
            await db.execute(
                select(WardCensus.source_fetched_at)
                .order_by(WardCensus.source_fetched_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    summary_row = (
        await db.execute(select(CityCensusSummary).where(CityCensusSummary.id == 1))
    ).scalar_one_or_none()
    summary = None
    if summary_row is not None:
        summary = CityCensusSummaryData(
            total_population=summary_row.total_population,
            total_area_sq_km=summary_row.total_area_sq_km,
            number_of_wards=summary_row.number_of_wards,
            total_water_supply_mld=summary_row.total_water_supply_mld,
            per_capita_supply_lpcd=summary_row.per_capita_supply_lpcd,
        )
    return cached_rows, summary, fetched_at


async def resolve_ward_census(db: AsyncSession, ward_label: str) -> WardCensusResolution:
    live_fetched_at = utcnow()
    async with httpx.AsyncClient(follow_redirects=True) as client:
        live_result = await fetch_live(client)

    if live_result is not None:
        rows, summary = live_result
        await _upsert_cache(db, rows, summary, live_fetched_at)
        matched, method, confidence = _best_match(ward_label, rows)
        return WardCensusResolution(
            data_source="live",
            source_fetched_at=live_fetched_at,
            matched=matched,
            match_method=method,
            match_confidence=confidence,
            city_summary=summary,
        )

    cached_rows, cached_summary, cached_fetched_at = await _read_cache(db)
    if not cached_rows:
        return WardCensusResolution(
            data_source="unavailable",
            source_fetched_at=None,
            matched=None,
            match_method="none",
            match_confidence=0.0,
            city_summary=None,
        )

    matched, method, confidence = _best_match(ward_label, cached_rows)
    return WardCensusResolution(
        data_source="cached",
        source_fetched_at=cached_fetched_at,
        matched=matched,
        match_method=method,
        match_confidence=confidence,
        city_summary=cached_summary,
    )

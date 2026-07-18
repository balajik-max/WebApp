"""Orchestrates ward census resolution + the water-demand calculation.

Shared by the `/analytics/water-demand` endpoint and the Analytics export
builder so both render from exactly one code path.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Feature
from app.services.analytics.scope import feature_conditions
from app.services.analytics.ward_census import WardCensusResolution, resolve_ward_census
from app.services.analytics.water_demand import (
    CPHEEO_LPCD_FALLBACK,
    WaterDemandBreakdown,
    compute_water_demand,
)


@dataclass(frozen=True, slots=True)
class WardWaterDemandResult:
    ward_label: str
    resolution: WardCensusResolution
    population_used: int | None
    population_source: str
    floating_population: int
    building_count_surveyed: int
    breakdown: WaterDemandBreakdown | None
    lpcd: float | None
    lpcd_source: str | None
    methodology: str
    generated_at: datetime
    supply_comparison: dict | None = None


async def build_ward_water_demand(
    db: AsyncSession,
    *,
    ward_label: str,
    dataset_ids: list[uuid.UUID],
    floating_population: int = 0,
    population_override: int | None = None,
    lpcd_override: float | None = None,
) -> WardWaterDemandResult:
    resolution = await resolve_ward_census(db, ward_label)

    if population_override is not None:
        population_used: int | None = population_override
        population_source = "manual_override"
    elif resolution.matched is not None:
        population_used = resolution.matched.persons
        population_source = "census"
    else:
        population_used = None
        population_source = "unavailable"

    building_conditions = feature_conditions(dataset_ids, ["Building"], [ward_label])
    building_count = int(
        (
            await db.execute(select(func.count(Feature.id)).where(*building_conditions))
        ).scalar_one()
        or 0
    )

    breakdown: WaterDemandBreakdown | None = None
    supply_comparison: dict | None = None
    lpcd: float | None = None
    lpcd_source: str | None = None

    if population_used is not None:
        if lpcd_override is not None:
            lpcd, lpcd_source = lpcd_override, "manual override"
        elif resolution.city_summary and resolution.city_summary.per_capita_supply_lpcd:
            lpcd = resolution.city_summary.per_capita_supply_lpcd
            lpcd_source = "Corporation's own published per-capita supply figure"
        else:
            lpcd, lpcd_source = CPHEEO_LPCD_FALLBACK, "CPHEEO Manual planning default"

        breakdown = compute_water_demand(
            population=population_used,
            floating_population=floating_population,
            lpcd=lpcd,
            lpcd_source=lpcd_source,
        )
        
        # Calculate supply comparison if city summary data is available
        if resolution.city_summary and resolution.city_summary.total_water_supply_mld is not None:
            total_demand_mld = breakdown.total_mld if breakdown else 0
            city_supply_mld = resolution.city_summary.total_water_supply_mld
            city_population = resolution.city_summary.total_population or 1
            
            # Calculate this ward's share of city supply (proportional to population)
            ward_population_share = population_used / city_population if city_population > 0 else 0
            expected_supply_for_ward = city_supply_mld * ward_population_share
            
            gap_mld = round(total_demand_mld - expected_supply_for_ward, 3)
            ward_lpcd = round((total_demand_mld * 1_000_000) / population_used, 1) if population_used else None
            expected_lpcd = round((expected_supply_for_ward * 1_000_000) / population_used, 1) if population_used else None
            if gap_mld <= 0:
                severity = "surplus"
            elif gap_mld <= 0.2:
                severity = "mild_deficit"
            elif gap_mld <= 0.5:
                severity = "moderate_deficit"
            else:
                severity = "severe_deficit"
            supply_comparison = {
                "ward_demand_mld": round(total_demand_mld, 3),
                "expected_supply_mld": round(expected_supply_for_ward, 3),
                "city_total_supply_mld": city_supply_mld,
                "city_total_population": city_population,
                "deficit_mld": round(max(0, total_demand_mld - expected_supply_for_ward), 3),
                "surplus_mld": round(max(0, expected_supply_for_ward - total_demand_mld), 3),
                "gap_mld": gap_mld,
                "demand_vs_expected_supply_pct": round((total_demand_mld / expected_supply_for_ward * 100) if expected_supply_for_ward > 0 else 0, 1),
                "ward_lpcd": ward_lpcd,
                "expected_lpcd": expected_lpcd,
                "is_deficit": total_demand_mld > expected_supply_for_ward if expected_supply_for_ward > 0 else False,
                "severity": severity,
                "note": (
                    "\"Fair share\" assumes the city's total supply is distributed in proportion to "
                    "population alone — it does not account for this ward's actual network capacity, "
                    "pipe age, or pressure zone. Treat this as a planning signal, not a metered fact."
                ),
            }

    if breakdown is not None:
        methodology = breakdown.methodology
    elif resolution.data_source == "unavailable":
        methodology = (
            "No population could be resolved: the census source was unreachable and no cached "
            "figure was available for this ward. Enter a population manually to generate a "
            "demand estimate."
        )
    else:
        methodology = (
            f"No census ward could be confidently matched to \"{ward_label}\" (best match "
            f"confidence {resolution.match_confidence:.0%}). Enter a population manually to "
            "generate a demand estimate, or correct the survey's ward tag."
        )

    return WardWaterDemandResult(
        ward_label=ward_label,
        resolution=resolution,
        population_used=population_used,
        population_source=population_source,
        floating_population=floating_population,
        building_count_surveyed=building_count,
        breakdown=breakdown,
        lpcd=lpcd,
        lpcd_source=lpcd_source,
        supply_comparison=supply_comparison,
        methodology=methodology,
        generated_at=datetime.now(timezone.utc),
    )

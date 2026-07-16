"""Deterministic ward water-demand calculation.

Every constant below is a stated planning assumption, not an official
citation — each one ships with its own explanation string so a client can
see exactly which number came from the Corporation's own data (population,
the 100 LPCD per-capita figure) versus which came from a standard planning
default. Nothing here is estimated by a model; the same inputs always
produce the same output.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# CPHEEO Manual on Water Supply — used only when the live per-capita figure
# from the Corporation's own city-summary page can't be resolved.
CPHEEO_LPCD_FALLBACK = 135.0

DRINKING_COOKING_LPCD = 5.0
INSTITUTIONAL_COMMERCIAL_PCT = 0.20
UFW_LOSS_PCT = 0.15

# Kuichling/National Board of Fire Underwriters empirical formula, expressed
# over a standard 3-hour firefighting duration commonly assumed in Indian
# municipal planning. A provision estimate, not a hydraulic design substitute.
FIRE_DURATION_MINUTES = 180.0


@dataclass(frozen=True, slots=True)
class WaterDemandLineItem:
    key: str
    label: str
    liters_per_day: float
    explanation: str


@dataclass(frozen=True, slots=True)
class WaterDemandBreakdown:
    population: int
    floating_population: int
    lpcd: float
    lpcd_source: str
    line_items: list[WaterDemandLineItem]
    total_liters_per_day: float
    total_mld: float
    fire_demand_liters: float
    methodology: str = field(default="")


def _fire_demand_liters(population: int) -> float:
    population_thousands = max(population, 0) / 1000.0
    sqrt_thousands = population_thousands**0.5
    liters_per_minute = 4637.0 * sqrt_thousands * (1 - 0.01 * sqrt_thousands)
    return max(liters_per_minute, 0.0) * FIRE_DURATION_MINUTES


def compute_water_demand(
    *,
    population: int,
    floating_population: int = 0,
    lpcd: float,
    lpcd_source: str,
    institutional_commercial_pct: float = INSTITUTIONAL_COMMERCIAL_PCT,
    ufw_loss_pct: float = UFW_LOSS_PCT,
    drinking_cooking_lpcd: float = DRINKING_COOKING_LPCD,
) -> WaterDemandBreakdown:
    effective_population = max(population, 0) + max(floating_population, 0)

    household_total = effective_population * lpcd
    drinking_cooking = min(effective_population * drinking_cooking_lpcd, household_total)
    other_household = household_total - drinking_cooking
    institutional = household_total * institutional_commercial_pct
    subtotal = household_total + institutional
    ufw_losses = subtotal * ufw_loss_pct
    total = subtotal + ufw_losses

    line_items = [
        WaterDemandLineItem(
            key="drinking_cooking",
            label="Drinking & cooking",
            liters_per_day=round(drinking_cooking, 1),
            explanation=(
                f"Planning assumption: {drinking_cooking_lpcd:.0f} litres/person/day for drinking and "
                "cooking, drawn from the household total (no official drinking-only figure is published)."
            ),
        ),
        WaterDemandLineItem(
            key="other_household",
            label="Other household use",
            liters_per_day=round(other_household, 1),
            explanation=(
                f"Household total at {lpcd:.0f} LPCD ({lpcd_source}) minus the drinking & cooking share."
            ),
        ),
        WaterDemandLineItem(
            key="institutional_commercial",
            label="Institutional & commercial",
            liters_per_day=round(institutional, 1),
            explanation=(
                f"Planning assumption: {institutional_commercial_pct * 100:.0f}% of household demand for "
                "schools, offices, and shops."
            ),
        ),
        WaterDemandLineItem(
            key="distribution_losses",
            label="Distribution losses (UFW)",
            liters_per_day=round(ufw_losses, 1),
            explanation=(
                f"Standard planning assumption: {ufw_loss_pct * 100:.0f}% unaccounted-for-water added to "
                "household + institutional demand so the total reflects what must actually be produced."
            ),
        ),
    ]

    fire_liters = _fire_demand_liters(effective_population)

    return WaterDemandBreakdown(
        population=population,
        floating_population=floating_population,
        lpcd=lpcd,
        lpcd_source=lpcd_source,
        line_items=line_items,
        total_liters_per_day=round(total, 1),
        total_mld=round(total / 1_000_000.0, 3),
        fire_demand_liters=round(fire_liters, 1),
        methodology=(
            "Total = (population + floating population) x per-capita allowance, split into drinking/"
            "cooking and other household use, plus institutional/commercial and distribution-loss "
            "percentages of household demand. Fire-fighting provision is a separate empirical estimate "
            f"(Kuichling formula over a {FIRE_DURATION_MINUTES:.0f}-minute duration) and is not included "
            "in the daily total. Every percentage and per-capita figure is a stated, overridable planning "
            "assumption unless noted as sourced from the Corporation's own published data."
        ),
    )

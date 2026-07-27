"""Backward-compatible exports for the earlier pothole SR module."""
from __future__ import annotations

from app.services.road_repair_catalog import (
    DEFAULT_FINANCIAL_YEAR as FINANCIAL_YEAR,
    MATERIAL_RATES_2026_27,
    RATES,
    classify_road_surface,
    depth_mm_from_metadata,
    normalize_text,
    rate_payload,
)

OFFICIAL_POTHOLE_RATES = {r.item_code: r for r in RATES if r.financial_year == "2026-27"}


def suggested_item_code(depth_mm: float | None) -> str:
    return "10.15(i)" if depth_mm is not None and depth_mm <= 25.0 else "10.15(ii)"


def official_rate_payload(item_code: str):
    return rate_payload(OFFICIAL_POTHOLE_RATES[item_code], requested_year="2026-27")

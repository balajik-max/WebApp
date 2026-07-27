"""Selected-pothole multi-surface Karnataka PWD repair costing.

Map clicks never depend on the KPWD website. The estimate uses the locally
verified catalogue; website/PDF synchronization is a separate admin action.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.road_repair_catalog import (
    DEFAULT_ESTIMATE_DATE,
    DEFAULT_FINANCIAL_YEAR,
    RATES,
    RepairRate,
    available_financial_years,
    classify_road_surface,
    default_item_code,
    depth_mm_from_metadata,
    rate_payload,
    resolve_rate,
)


def calculate_cost(*, quantity: float, rate_value: float, labour_enabled: bool, labour_charge: float) -> dict[str, float]:
    quantity = max(0.0, float(quantity))
    rate = max(0.0, float(rate_value))
    labour = max(0.0, float(labour_charge)) if labour_enabled else 0.0
    base = round(quantity * rate, 2)
    return {
        "base_repair_cost_inr": base,
        "labour_charge_per_pothole_inr": round(labour, 2),
        "total_repair_cost_inr": round(base + labour, 2),
    }


async def _load_anomaly_values(db: AsyncSession, anomaly_id: uuid.UUID) -> tuple[uuid.UUID, dict[str, Any]]:
    from app.models import SpatialAnomaly

    row = (
        await db.execute(
            select(SpatialAnomaly.id, SpatialAnomaly.anomaly_type, SpatialAnomaly.anomaly_metadata).where(
                SpatialAnomaly.id == anomaly_id
            )
        )
    ).one_or_none()
    if row is None:
        raise LookupError("Pothole finding was not found")
    row_id, anomaly_type, anomaly_metadata = row
    if getattr(anomaly_type, "value", str(anomaly_type)) != "pothole_status":
        raise ValueError("Repair-cost calculation is available only for pothole findings")
    return row_id, dict(anomaly_metadata or {})


async def _override_row(db: AsyncSession, *, user_id: uuid.UUID, anomaly_id: uuid.UUID) -> dict[str, Any] | None:
    result = await db.execute(
        text(
            """
            SELECT rate_mode, financial_year, estimate_date, selected_item_code,
                   manual_rate_per_sqm, manual_rate_value, manual_rate_unit,
                   repair_depth_mm, labour_enabled, labour_charge_per_pothole_inr,
                   additional_charge_reason, updated_at
            FROM pothole_cost_overrides
            WHERE user_id = :user_id AND anomaly_id = :anomaly_id
            """
        ),
        {"user_id": str(user_id), "anomaly_id": str(anomaly_id)},
    )
    row = result.mappings().one_or_none()
    return dict(row) if row else None


def _safe_area(metadata: dict[str, Any]) -> float:
    try:
        area = float(metadata.get("area_sqm"))
    except (TypeError, ValueError):
        area = 0.0
    if area <= 0:
        raise ValueError("Mapped pothole area is unavailable")
    return round(area, 4)


def _parse_date(value: Any, default: date) -> date:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return default


async def _dynamic_rates(
    db: AsyncSession, *, financial_year: str, estimate_date: date, surface: str
) -> dict[str, RepairRate]:
    result = await db.execute(
        text(
            """
            SELECT DISTINCT ON (item_code)
                   item_code, road_surface, repair_method, unit, rate_value,
                   effective_from, source_document, source_page, source_url,
                   verification_status, gst_included
            FROM kpwd_sr_rates
            WHERE financial_year = :financial_year
              AND effective_from <= :estimate_date
              AND verification_status IN ('engineer_verified', 'auto_extracted_high_confidence')
              AND (:surface = 'unknown' OR road_surface = :surface OR road_surface = 'composite')
            ORDER BY item_code, effective_from DESC, updated_at DESC
            """
        ),
        {"financial_year": financial_year, "estimate_date": estimate_date, "surface": surface},
    )
    rates: dict[str, RepairRate] = {}
    for row in result.mappings():
        rates[str(row["item_code"])] = RepairRate(
            financial_year=financial_year,
            item_code=str(row["item_code"]),
            road_surfaces=(str(row["road_surface"]),),
            repair_method=str(row["repair_method"]),
            description=str(row["repair_method"]),
            unit=str(row["unit"]),
            rate=float(row["rate_value"]),
            effective_from=row["effective_from"],
            source_document=str(row["source_document"]),
            source_page=int(row["source_page"]) if row["source_page"] is not None else None,
            status=str(row["verification_status"]),
            gst_included=bool(row["gst_included"]),
            quantity_basis="volume" if str(row["unit"]) == "m3" else "area",
            source_url=str(row["source_url"]),
        )
    return rates


def _resolve_with_dynamic(
    *, dynamic_rates: dict[str, RepairRate], financial_year: str, item_code: str,
    estimate_date: date, road_surface: str
) -> tuple[RepairRate | None, str | None]:
    dynamic = dynamic_rates.get(item_code)
    if dynamic is not None:
        return dynamic, None
    return resolve_rate(
        financial_year=financial_year, item_code=item_code,
        estimate_date=estimate_date, road_surface=road_surface,
    )


def _available_options(
    financial_year: str, surface: str, estimate_date: date,
    dynamic_rates: dict[str, RepairRate],
) -> list[dict[str, Any]]:
    item_codes: list[str] = list(dynamic_rates)
    for rate in RATES:
        if surface != "unknown" and surface not in rate.road_surfaces:
            continue
        if rate.item_code not in item_codes:
            item_codes.append(rate.item_code)
    options: list[dict[str, Any]] = []
    for code in item_codes:
        resolved, warning = _resolve_with_dynamic(
            dynamic_rates=dynamic_rates, financial_year=financial_year,
            item_code=code, estimate_date=estimate_date, road_surface=surface,
        )
        if resolved is None:
            continue
        options.append(
            {
                "item_code": code,
                "label": resolved.repair_method,
                "unit": resolved.unit,
                "rate_value": resolved.rate,
                "status": "base_reference" if warning else "verified",
            }
        )
    return options


def _material_rows(rate: RepairRate, quantity: float | None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for material in rate.materials:
        material_quantity = None
        amount = None
        if quantity is not None and material.quantity_per_item_unit is not None:
            material_quantity = round(quantity * material.quantity_per_item_unit, 4)
            if material.rate is not None:
                amount = round(material_quantity * material.rate, 2)
        rows.append(
            {
                "name": material.name,
                "quantity": material_quantity,
                "quantity_unit": material.quantity_unit,
                "rate": material.rate,
                "rate_unit": material.rate_unit,
                "amount_inr": amount,
                "rate_year": material.rate_year,
                "source_document": material.source_document,
                "source_page": material.source_page,
                "note": material.note,
                "included_in_finished_rate": True,
            }
        )
    return rows


def _manual_rate_payload(*, value: float | None, unit: str, financial_year: str) -> dict[str, Any]:
    return {
        "rate_value": value,
        "rate_per_sqm": value if unit == "m2" else None,
        "unit": f"INR/{unit}",
        "source": "User-entered engineer-approved rate" if value else "Manual rate required",
        "year": financial_year,
        "rate_basis_year": None,
        "item_code": "MANUAL",
        "item_description": "Engineer-entered rate for the selected pothole",
        "effective_from": None,
        "source_document": None,
        "source_page": None,
        "source_url": None,
        "status": "manual_user_rate" if value else "manual_rate_required",
        "verified_at": None,
        "last_sync_error": None,
        "gst_included": False,
        "rate_mode": "manual",
    }


def _estimate_from_values(
    *, anomaly_id: uuid.UUID, metadata: dict[str, Any],
    override: dict[str, Any] | None, dynamic_rates: dict[str, RepairRate] | None = None,
) -> dict[str, Any]:
    area_sqm = _safe_area(metadata)
    road_category = str(
        metadata.get("nearest_road_category")
        or metadata.get("road_type")
        or metadata.get("type_of_road")
        or metadata.get("road_surface")
        or ""
    ).strip()
    road_surface = classify_road_surface(road_category)
    road_type_source = str(metadata.get("road_type_source") or "Road_Centerline.Type_of_Road") if road_category else None

    depth_from_override = (override or {}).get("repair_depth_mm")
    depth_mm = float(depth_from_override) if depth_from_override is not None else depth_mm_from_metadata(metadata)
    pothole_type = "shallow" if depth_mm is not None and depth_mm <= 25.0 else "deep"

    financial_year = str((override or {}).get("financial_year") or DEFAULT_FINANCIAL_YEAR)
    estimate_date = _parse_date((override or {}).get("estimate_date"), DEFAULT_ESTIMATE_DATE)
    rate_mode = str((override or {}).get("rate_mode") or "official")
    if rate_mode not in {"official", "manual"}:
        rate_mode = "official"

    auto_item = default_item_code(road_surface, depth_mm) or ""
    selected_item_code = str((override or {}).get("selected_item_code") or auto_item)
    dynamic_rates = dynamic_rates or {}
    options = _available_options(financial_year, road_surface, estimate_date, dynamic_rates)
    valid_codes = {option["item_code"] for option in options}
    if rate_mode == "official" and selected_item_code not in valid_codes:
        selected_item_code = auto_item if auto_item in valid_codes else (options[0]["item_code"] if options else "")

    labour_enabled = bool((override or {}).get("labour_enabled", False))
    labour_charge = float((override or {}).get("labour_charge_per_pothole_inr") or 0.0)
    additional_reason = str((override or {}).get("additional_charge_reason") or "").strip() or None

    warning: str | None = None
    materials: list[dict[str, Any]] = []
    official_rate_applicable = bool(options)
    selected_rate: RepairRate | None = None

    manual_rate_raw = (override or {}).get("manual_rate_value")
    if manual_rate_raw is None:
        manual_rate_raw = (override or {}).get("manual_rate_per_sqm")
    manual_rate = float(manual_rate_raw) if manual_rate_raw is not None else None
    manual_unit = str((override or {}).get("manual_rate_unit") or "m2")
    if manual_unit not in {"m2", "m3"}:
        manual_unit = "m2"

    if rate_mode == "official" and selected_item_code:
        selected_rate, warning = _resolve_with_dynamic(
            dynamic_rates=dynamic_rates, financial_year=financial_year,
            item_code=selected_item_code, estimate_date=estimate_date,
            road_surface=road_surface,
        )
        if selected_rate is None:
            rate_mode = "manual"
            official_rate_applicable = False

    if rate_mode == "official" and selected_rate is not None:
        rate_value = selected_rate.rate
        unit = selected_rate.unit
        rate = rate_payload(selected_rate, requested_year=financial_year, warning=warning)
        repair_method = selected_rate.repair_method
        calculation_status = "official_rate_applied" if not warning else "base_sr_reference_applied"
    else:
        rate_value = manual_rate if manual_rate and manual_rate > 0 else None
        unit = manual_unit
        rate = _manual_rate_payload(value=rate_value, unit=unit, financial_year=financial_year)
        repair_method = "Engineer-approved manual repair method"
        calculation_status = "manual_rate_applied" if rate_value else "manual_rate_required"
        if not warning and not official_rate_applicable:
            warning = "No verified automatic SR item is available for the selected road surface/year. Enter an engineer-approved rate."

    if unit == "m3":
        quantity_unit = "m3"
        calculated_quantity = round(area_sqm * depth_mm / 1000.0, 4) if depth_mm is not None else None
        if calculated_quantity is None:
            warning = (warning + " " if warning else "") + "Repair depth is required because this item is measured in cubic metres."
    else:
        quantity_unit = "m2"
        calculated_quantity = area_sqm

    if rate_value is None or calculated_quantity is None:
        base_cost = None
        applied_labour = round(labour_charge, 2) if labour_enabled else 0.0
        total_cost = None
        formula = "Rate and measured quantity are required before calculation"
    else:
        amounts = calculate_cost(
            quantity=calculated_quantity,
            rate_value=rate_value,
            labour_enabled=labour_enabled,
            labour_charge=labour_charge,
        )
        base_cost = amounts["base_repair_cost_inr"]
        applied_labour = amounts["labour_charge_per_pothole_inr"]
        total_cost = amounts["total_repair_cost_inr"]
        formula = f"{calculated_quantity:.4f} {quantity_unit} x INR {rate_value:.2f}/{unit}"
        if labour_enabled:
            formula += f" + INR {applied_labour:.2f} approved additional charge"

    if selected_rate is not None:
        materials = _material_rows(selected_rate, calculated_quantity)

    return {
        "anomaly_id": anomaly_id,
        "area_sqm": area_sqm,
        "depth_mm": depth_mm,
        "calculated_quantity": calculated_quantity,
        "quantity_unit": quantity_unit,
        "road_category": road_category or "Not available",
        "road_surface": road_surface,
        "road_type_source": road_type_source,
        "pothole_type": pothole_type,
        "recommended_repair_method": repair_method,
        "financial_year": financial_year,
        "estimate_date": estimate_date,
        "rate_mode": rate_mode,
        "selected_item_code": selected_item_code or "MANUAL",
        "available_items": options,
        "manual_rate_value": manual_rate,
        "manual_rate_unit": manual_unit,
        "manual_rate_per_sqm": manual_rate if manual_unit == "m2" else None,
        "official_rate_applicable": official_rate_applicable,
        "base_repair_cost_inr": base_cost,
        "labour_charge_enabled": labour_enabled,
        "labour_charge_per_pothole_inr": applied_labour,
        "additional_charge_reason": additional_reason,
        "total_repair_cost_inr": total_cost,
        "rate": rate,
        "materials": materials,
        "material_breakdown_informational_only": True,
        "calculation_status": calculation_status,
        "calculation_formula": formula,
        "online_refresh_attempted": False,
        "warning": warning,
    }


async def estimate_pothole_cost(
    db: AsyncSession,
    *,
    anomaly_id: uuid.UUID,
    user_id: uuid.UUID,
    refresh_online: bool = False,
    financial_year: str | None = None,
    estimate_date: date | None = None,
) -> dict[str, Any]:
    del refresh_online
    row_id, metadata = await _load_anomaly_values(db, anomaly_id)
    override = await _override_row(db, user_id=user_id, anomaly_id=row_id) or {}
    if financial_year:
        override["financial_year"] = financial_year
    if estimate_date:
        override["estimate_date"] = estimate_date
    selected_year = str(override.get("financial_year") or DEFAULT_FINANCIAL_YEAR)
    selected_date = _parse_date(override.get("estimate_date"), DEFAULT_ESTIMATE_DATE)
    surface = classify_road_surface(
        metadata.get("nearest_road_category") or metadata.get("road_type")
        or metadata.get("type_of_road") or metadata.get("road_surface") or ""
    )
    dynamic = await _dynamic_rates(db, financial_year=selected_year, estimate_date=selected_date, surface=surface)
    return _estimate_from_values(anomaly_id=row_id, metadata=metadata, override=override, dynamic_rates=dynamic)


async def save_pothole_estimate_override(
    db: AsyncSession,
    *,
    anomaly_id: uuid.UUID,
    user_id: uuid.UUID,
    rate_mode: str,
    financial_year: str,
    estimate_date: date | None,
    selected_item_code: str | None,
    repair_depth_mm: float | None,
    manual_rate_value: float | None,
    manual_rate_unit: str,
    labour_enabled: bool,
    labour_charge_per_pothole_inr: float,
    additional_charge_reason: str | None,
) -> dict[str, Any]:
    row_id, metadata = await _load_anomaly_values(db, anomaly_id)
    await db.execute(
        text(
            """
            INSERT INTO pothole_cost_overrides (
                user_id, anomaly_id, rate_mode, financial_year, estimate_date,
                selected_item_code, manual_rate_per_sqm, manual_rate_value,
                manual_rate_unit, repair_depth_mm, labour_enabled,
                labour_charge_per_pothole_inr, additional_charge_reason, updated_at
            ) VALUES (
                :user_id, :anomaly_id, :rate_mode, :financial_year, :estimate_date,
                :selected_item_code, :legacy_manual_rate, :manual_rate_value,
                :manual_rate_unit, :repair_depth_mm, :labour_enabled,
                :labour_charge, :additional_charge_reason, now()
            )
            ON CONFLICT (user_id, anomaly_id) DO UPDATE SET
                rate_mode = EXCLUDED.rate_mode,
                financial_year = EXCLUDED.financial_year,
                estimate_date = EXCLUDED.estimate_date,
                selected_item_code = EXCLUDED.selected_item_code,
                manual_rate_per_sqm = EXCLUDED.manual_rate_per_sqm,
                manual_rate_value = EXCLUDED.manual_rate_value,
                manual_rate_unit = EXCLUDED.manual_rate_unit,
                repair_depth_mm = EXCLUDED.repair_depth_mm,
                labour_enabled = EXCLUDED.labour_enabled,
                labour_charge_per_pothole_inr = EXCLUDED.labour_charge_per_pothole_inr,
                additional_charge_reason = EXCLUDED.additional_charge_reason,
                updated_at = now()
            """
        ),
        {
            "user_id": str(user_id),
            "anomaly_id": str(row_id),
            "rate_mode": rate_mode,
            "financial_year": financial_year,
            "estimate_date": estimate_date or DEFAULT_ESTIMATE_DATE,
            "selected_item_code": selected_item_code,
            "legacy_manual_rate": manual_rate_value if manual_rate_unit == "m2" else None,
            "manual_rate_value": manual_rate_value,
            "manual_rate_unit": manual_rate_unit,
            "repair_depth_mm": repair_depth_mm,
            "labour_enabled": labour_enabled,
            "labour_charge": max(0.0, float(labour_charge_per_pothole_inr)),
            "additional_charge_reason": additional_charge_reason,
        },
    )
    await db.commit()
    override = await _override_row(db, user_id=user_id, anomaly_id=row_id) or {}
    selected_date = _parse_date(override.get("estimate_date"), DEFAULT_ESTIMATE_DATE)
    surface = classify_road_surface(
        metadata.get("nearest_road_category") or metadata.get("road_type")
        or metadata.get("type_of_road") or metadata.get("road_surface") or ""
    )
    dynamic = await _dynamic_rates(db, financial_year=str(override.get("financial_year") or DEFAULT_FINANCIAL_YEAR), estimate_date=selected_date, surface=surface)
    return _estimate_from_values(anomaly_id=row_id, metadata=metadata, override=override, dynamic_rates=dynamic)


async def get_cost_settings(db: AsyncSession, user_id: uuid.UUID) -> dict[str, Any]:
    del db, user_id
    sample_rate, warning = resolve_rate(
        financial_year=DEFAULT_FINANCIAL_YEAR,
        item_code="10.5",
        estimate_date=DEFAULT_ESTIMATE_DATE,
        road_surface="bituminous",
    )
    assert sample_rate is not None
    return {
        "labour": {"enabled": False, "charge_per_pothole_inr": 0.0, "updated_at": None},
        "rate": rate_payload(sample_rate, requested_year=DEFAULT_FINANCIAL_YEAR, warning=warning),
    }


async def update_labour_settings(db: AsyncSession, user_id: uuid.UUID, *, enabled: bool, charge_per_pothole_inr: float) -> dict[str, Any]:
    del db, user_id
    return {"enabled": enabled, "charge_per_pothole_inr": round(max(0.0, charge_per_pothole_inr), 2), "updated_at": None}


def get_available_years() -> list[str]:
    return available_financial_years()

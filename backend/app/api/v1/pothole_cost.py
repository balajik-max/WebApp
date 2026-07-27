"""Selected-pothole, multi-surface Karnataka PWD repair-cost endpoints."""
from __future__ import annotations

import re
import uuid
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin, require_any
from app.db.session import get_db
from app.models import User
from app.schemas.pothole_cost import (
    FinancialYearOut,
    PotholeCostEstimateOut,
    PotholeCostSettingsOut,
    PotholeEstimateUpdate,
    PotholeLabourSettingsUpdate,
    PotholeRateSyncOut,
)
from app.services.kpwd_sr_sync import cached_financial_years, sync_financial_year
from app.services.pothole_costing import (
    estimate_pothole_cost,
    get_available_years,
    get_cost_settings,
    save_pothole_estimate_override,
    update_labour_settings,
)

router = APIRouter()
_STATIC_DIR = Path(__file__).resolve().parents[2] / "static" / "kpwd"
_SOURCE_FILES = {
    "document-152": (_STATIC_DIR / "Document_152_2026-27.pdf", "Karnataka_PWD_2026-27_Document_152.pdf"),
    "issue-rates-04": (_STATIC_DIR / "Issue_Rates_04_2026-27.pdf", "Karnataka_PWD_2026-27_Issue_Rates_04.pdf"),
    "roads-bridges-2023-24": (_STATIC_DIR / "Roads_Bridges_Volume_III_2023-24.pdf", "Karnataka_PWD_Roads_Bridges_Volume_III_2023-24.pdf"),
    "common-sr-2023-24": (_STATIC_DIR / "Common_SR_Volume_I_2023-24.pdf", "Karnataka_PWD_Common_SR_Volume_I_2023-24.pdf"),
}


@router.get("/years", response_model=list[FinancialYearOut])
async def financial_years(
    user: User = Depends(require_any),
    db: AsyncSession = Depends(get_db),
) -> list[FinancialYearOut]:
    del user
    rows = {item["financial_year"]: item for item in await cached_financial_years(db)}
    for financial_year in get_available_years():
        rows.setdefault(
            financial_year,
            {
                "financial_year": financial_year,
                "source_url": None,
                "cached": True,
            },
        )
    return [FinancialYearOut.model_validate(rows[key]) for key in sorted(rows, reverse=True)]


@router.get("/settings", response_model=PotholeCostSettingsOut)
async def pothole_cost_settings(
    user: User = Depends(require_any),
    db: AsyncSession = Depends(get_db),
) -> PotholeCostSettingsOut:
    return PotholeCostSettingsOut.model_validate(await get_cost_settings(db, user.id))


@router.put("/settings", response_model=PotholeCostSettingsOut)
async def save_legacy_pothole_cost_settings(
    body: PotholeLabourSettingsUpdate,
    user: User = Depends(require_any),
    db: AsyncSession = Depends(get_db),
) -> PotholeCostSettingsOut:
    await update_labour_settings(
        db,
        user.id,
        enabled=body.enabled,
        charge_per_pothole_inr=body.charge_per_pothole_inr,
    )
    return PotholeCostSettingsOut.model_validate(await get_cost_settings(db, user.id))


@router.post("/rates/sync/{financial_year}", response_model=PotholeRateSyncOut)
async def sync_official_rates(
    financial_year: str,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PotholeRateSyncOut:
    del admin
    if not re.fullmatch(r"\d{4}-\d{2}", financial_year):
        raise HTTPException(status_code=422, detail="Financial year must use YYYY-YY format, for example 2026-27")
    try:
        payload = await sync_financial_year(db, financial_year)
    except Exception as exc:
        # Keep map costing available from locally verified records even when the
        # government website is slow or unavailable.
        raise HTTPException(
            status_code=503,
            detail=f"KPWD synchronization failed; existing cached rates remain available. {exc}",
        ) from exc
    return PotholeRateSyncOut.model_validate(payload)


# Backward-compatible route retained for old clients.
@router.post("/rate/sync", response_model=PotholeRateSyncOut)
async def sync_current_official_rate(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PotholeRateSyncOut:
    del admin
    try:
        return PotholeRateSyncOut.model_validate(await sync_financial_year(db, "2026-27"))
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"KPWD synchronization failed; existing cached rates remain available. {exc}",
        ) from exc


@router.get("/source/current", include_in_schema=False)
async def current_source_pdf(user: User = Depends(require_any)) -> FileResponse:
    del user
    return await source_pdf("document-152")


@router.get("/source/{source_key}", include_in_schema=False)
async def source_pdf(source_key: str, user: User = Depends(require_any)) -> FileResponse:
    del user
    source = _SOURCE_FILES.get(source_key)
    if source is None:
        raise HTTPException(status_code=404, detail="Requested bundled Karnataka PWD source PDF was not found")
    path, filename = source
    if not path.exists():
        raise HTTPException(status_code=404, detail="Bundled Karnataka PWD source PDF was not found")
    return FileResponse(path, media_type="application/pdf", filename=filename)


@router.get("/estimate/{anomaly_id}", response_model=PotholeCostEstimateOut)
async def pothole_cost_estimate(
    anomaly_id: uuid.UUID,
    refresh_online: bool = Query(default=False),
    financial_year: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"),
    estimate_date: date | None = Query(default=None),
    user: User = Depends(require_any),
    db: AsyncSession = Depends(get_db),
) -> PotholeCostEstimateOut:
    try:
        payload = await estimate_pothole_cost(
            db,
            anomaly_id=anomaly_id,
            user_id=user.id,
            refresh_online=refresh_online,
            financial_year=financial_year,
            estimate_date=estimate_date,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return PotholeCostEstimateOut.model_validate(payload)


@router.put("/estimate/{anomaly_id}", response_model=PotholeCostEstimateOut)
async def save_pothole_cost_estimate(
    anomaly_id: uuid.UUID,
    body: PotholeEstimateUpdate,
    user: User = Depends(require_any),
    db: AsyncSession = Depends(get_db),
) -> PotholeCostEstimateOut:
    try:
        payload = await save_pothole_estimate_override(
            db,
            anomaly_id=anomaly_id,
            user_id=user.id,
            rate_mode=body.rate_mode,
            financial_year=body.financial_year,
            estimate_date=body.estimate_date,
            selected_item_code=body.selected_item_code,
            repair_depth_mm=body.repair_depth_mm,
            manual_rate_value=body.manual_rate_value,
            manual_rate_unit=body.manual_rate_unit,
            labour_enabled=body.labour_enabled,
            labour_charge_per_pothole_inr=body.labour_charge_per_pothole_inr,
            additional_charge_reason=body.additional_charge_reason,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return PotholeCostEstimateOut.model_validate(payload)

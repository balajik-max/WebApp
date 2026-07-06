"""Health & readiness probes."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_db

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    s = get_settings()
    return {"status": "ok", "app": s.app_name, "env": s.app_env}


@router.get("/ready")
async def ready(db: AsyncSession = Depends(get_db)) -> dict:
    await db.execute(text("SELECT 1"))
    postgis_row = (await db.execute(text("SELECT PostGIS_Full_Version()"))).scalar()
    return {"status": "ready", "postgis": postgis_row}

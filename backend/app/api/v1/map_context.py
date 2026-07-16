"""Small map-context helpers used by the live status strip."""
from __future__ import annotations

import math
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db

router = APIRouter()

_ELEVATION_KEYS = (
    "elevation",
    "Elevation",
    "ELEVATION",
    "z",
    "Z",
    "height",
    "Height",
    "HEIGHT",
    "rl",
    "RL",
    "band_1",
)


@router.get("/elevation", dependencies=[Depends(require_any)])
async def sample_elevation(
    dataset_id: uuid.UUID,
    longitude: float = Query(ge=-180, le=180),
    latitude: float = Query(ge=-90, le=90),
    db: AsyncSession = Depends(get_db),
) -> dict:
    row = (
        await db.execute(
            text(
                """
                SELECT
                    f.attributes,
                    ST_DistanceSphere(
                        f.geom,
                        ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)
                    ) AS distance_m
                FROM features f
                WHERE f.dataset_id = :dataset_id
                  AND f.category = 'raster_pixel'
                ORDER BY f.geom <-> ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)
                LIMIT 1
                """
            ),
            {
                "dataset_id": dataset_id,
                "longitude": longitude,
                "latitude": latitude,
            },
        )
    ).mappings().first()
    if row is None:
        return {"elevation": None, "distance_m": None, "source": None}

    attributes = row["attributes"] or {}
    elevation: float | None = None
    for key in _ELEVATION_KEYS:
        value = attributes.get(key)
        try:
            candidate = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(candidate):
            elevation = candidate
            break

    return {
        "elevation": elevation,
        "distance_m": float(row["distance_m"]) if row["distance_m"] is not None else None,
        "source": "nearest-raster-sample" if elevation is not None else None,
    }

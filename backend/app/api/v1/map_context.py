"""Small map-context helpers used by the live status strip."""
from __future__ import annotations

import math
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError, ProjError

from app.api.deps import require_any
from app.db.session import get_db
from app.schemas.coordinate_search import CoordinateTransformRequest, CoordinateTransformResponse

router = APIRouter()

_ELEVATION_KEYS = (
    "elevation",
    "Elevation",
    "ELEVATION",
    "elevation_m",
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
                  AND f.category IN ('raster_pixel', 'lidar_point')
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

@router.post(
    "/coordinate-transform",
    response_model=CoordinateTransformResponse,
    dependencies=[Depends(require_any)],
)
async def transform_coordinate(body: CoordinateTransformRequest) -> CoordinateTransformResponse:
    """Transform projected dataset X/Y into map longitude/latitude."""
    try:
        source = CRS.from_user_input(body.source_crs)
        target = CRS.from_user_input(body.target_crs)
        transformer = Transformer.from_crs(source, target, always_xy=True)
        longitude, latitude = transformer.transform(body.x, body.y)
    except (CRSError, ProjError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Unable to transform coordinates: {exc}") from exc

    if not (math.isfinite(longitude) and math.isfinite(latitude)):
        raise HTTPException(status_code=422, detail="Coordinate transformation returned non-finite values.")

    if target.to_epsg() == 4326:
        if latitude < -90 or latitude > 90 or longitude < -180 or longitude > 180:
            raise HTTPException(
                status_code=422,
                detail="The transformed point is outside valid WGS84 latitude/longitude bounds.",
            )

    authority = source.to_authority()
    normalized_source = f"{authority[0]}:{authority[1]}" if authority else source.to_string()
    target_authority = target.to_authority()
    normalized_target = f"{target_authority[0]}:{target_authority[1]}" if target_authority else target.to_string()

    return CoordinateTransformResponse(
        source_x=body.x,
        source_y=body.y,
        source_crs=normalized_source,
        longitude=longitude,
        latitude=latitude,
        target_crs=normalized_target,
    )

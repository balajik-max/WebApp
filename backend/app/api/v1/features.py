"""
Features router.

Endpoints (mounted under /api/v1/features):
  GET  /                              – viewport-filtered feature list (GeoJSON)
  POST /{feature_id}/versions         – upload a revised design snapshot
  GET  /{feature_id}/versions         – list version history (desc)
  GET  /{feature_id}/activity         – immutable activity timeline

The list endpoint uses PostGIS `ST_Intersects` against `ST_MakeEnvelope`
at SRID 4326 so the GIST index `idx_features_geom` is engaged.  The
response is a strict GeoJSON `FeatureCollection` for direct MapLibre use.
"""
from __future__ import annotations

import io
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status as httpstatus,
)
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_any
from app.db.session import get_db
from app.models import (
    ActivityAction,
    ActivityLog,
    Feature,
    FeatureVersion,
    User,
)
from app.schemas.workflow import ActivityOut, FeatureVersionOut
from app.services.storage import ensure_bucket, upload_stream

log = logging.getLogger("davangere.api.features")
router = APIRouter()

_HARD_ROW_LIMIT = 5000
_DEFAULT_ROW_LIMIT = 2000


@router.get(
    "/categories",
    dependencies=[Depends(require_any)],
    summary="Distinct feature categories with counts (for filter dropdowns)",
)
async def list_categories(
    ward: str | None = Query(default=None, max_length=128),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from app.models import Dataset

    category_expr = func.coalesce(Feature.category, "uncategorized")
    stmt = select(category_expr.label("category"), func.count(Feature.id).label("count"))
    if ward is not None:
        stmt = stmt.join(Dataset, Dataset.id == Feature.dataset_id).where(Dataset.ward == ward)
    stmt = stmt.group_by(category_expr).order_by(func.count(Feature.id).desc())

    rows = (await db.execute(stmt)).all()
    return {"categories": [{"category": r.category, "count": int(r.count)} for r in rows]}


def _parse_bbox(raw: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise HTTPException(
            status_code=400,
            detail="bbox must be 'minLon,minLat,maxLon,maxLat'",
        )
    try:
        min_x, min_y, max_x, max_y = (float(p) for p in parts)
    except ValueError:
        raise HTTPException(status_code=400, detail="bbox values must be numeric")

    if not (-180.0 <= min_x <= 180.0 and -180.0 <= max_x <= 180.0):
        raise HTTPException(status_code=400, detail="bbox longitude out of range")
    if not (-90.0 <= min_y <= 90.0 and -90.0 <= max_y <= 90.0):
        raise HTTPException(status_code=400, detail="bbox latitude out of range")
    if min_x >= max_x or min_y >= max_y:
        raise HTTPException(status_code=400, detail="bbox min must be < max")

    return min_x, min_y, max_x, max_y


# ---------------------------------------------------------------------------
# GET /api/v1/features
# ---------------------------------------------------------------------------
@router.get(
    "",
    dependencies=[Depends(require_any)],
    summary="Viewport-filtered features as GeoJSON",
)
async def list_features_in_viewport(
    bbox: str = Query(..., description="minLon,minLat,maxLon,maxLat (WGS84)"),
    ward: str | None = Query(default=None, max_length=128),
    category: str | None = Query(default=None, max_length=128),
    severity: int | None = Query(default=None, description="Minimum severity threshold"),
    dataset_id: list[uuid.UUID] | None = Query(
        default=None,
        description=(
            "Restrict to one or more datasets (used by the map's dataset-click "
            "isolation / multi-dataset selection). Repeat the param for more than one."
        ),
    ),
    limit: int = Query(default=_DEFAULT_ROW_LIMIT, ge=1, le=_HARD_ROW_LIMIT),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    min_x, min_y, max_x, max_y = _parse_bbox(bbox)

    conditions = [
        "ST_Intersects(f.geom, ST_MakeEnvelope(:min_x, :min_y, :max_x, :max_y, 4326))"
    ]
    params: dict[str, Any] = {
        "min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y,
        "limit": limit,
    }

    join_dataset = ward is not None
    if ward is not None:
        conditions.append("d.ward = :ward")
        params["ward"] = ward
    if category is not None:
        conditions.append("f.category = :category")
        params["category"] = category
    if severity is not None:
        conditions.append("f.severity >= :severity")
        params["severity"] = float(severity)
    if dataset_id:
        conditions.append("f.dataset_id = ANY(:dataset_ids)")
        params["dataset_ids"] = dataset_id

    where_clause = " AND ".join(conditions)
    join_clause = "JOIN datasets d ON d.id = f.dataset_id" if join_dataset else ""

    sql = text(
        f"""
        SELECT
            f.id::text                          AS id,
            f.dataset_id::text                  AS dataset_id,
            f.label                             AS label,
            f.category                          AS category,
            f.severity                          AS severity,
            f.attributes                        AS attributes,
            ST_AsGeoJSON(f.geom)::text          AS geom_json
        FROM features f
        {join_clause}
        WHERE {where_clause}
        ORDER BY f.severity DESC
        LIMIT :limit
        """
    )
    result = await db.execute(sql, params)
    rows = result.mappings().all()

    features: list[dict[str, Any]] = []
    for row in rows:
        geometry = json.loads(row["geom_json"]) if row["geom_json"] else None
        features.append(
            {
                "type": "Feature",
                "id": row["id"],
                "geometry": geometry,
                "properties": {
                    "id": row["id"],
                    "dataset_id": row["dataset_id"],
                    "label": row["label"],
                    "category": row["category"],
                    "severity": row["severity"],
                    "attributes": row["attributes"] or {},
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "features": features,
        "bbox": [min_x, min_y, max_x, max_y],
        "count": len(features),
        "limit": limit,
        "truncated": len(features) >= limit,
    }


# ---------------------------------------------------------------------------
# POST /api/v1/features/{feature_id}/versions
# ---------------------------------------------------------------------------
@router.post(
    "/{feature_id}/versions",
    response_model=FeatureVersionOut,
    status_code=httpstatus.HTTP_201_CREATED,
    summary="Upload a revised design snapshot (auto-increments version)",
)
async def create_feature_version(
    feature_id: uuid.UUID,
    file: UploadFile = File(..., description="Revised CAD / geometry file"),
    change_note: str | None = Form(default=None, max_length=1024),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FeatureVersionOut:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Uploaded file has no filename")

    feature = (
        await db.execute(select(Feature).where(Feature.id == feature_id))
    ).scalar_one_or_none()
    if feature is None:
        raise HTTPException(status_code=404, detail="Feature not found")

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    await ensure_bucket()
    artefact_id = uuid.uuid4()
    storage_key = f"versions/{feature_id}/{artefact_id}_{file.filename}"
    await upload_stream(
        io.BytesIO(payload),
        key=storage_key,
        content_type=file.content_type,
    )

    next_version = (
        (
            await db.execute(
                select(func.coalesce(func.max(FeatureVersion.version), 0)).where(
                    FeatureVersion.feature_id == feature_id
                )
            )
        ).scalar_one()
        + 1
    )

    row = FeatureVersion(
        feature_id=feature_id,
        version=next_version,
        geom=feature.geom,
        attributes={
            "storage_key": storage_key,
            "filename": file.filename,
            "content_type": file.content_type,
            "size_bytes": len(payload),
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
            "prior_attributes": feature.attributes,
        },
        change_note=change_note,
        edited_by=current_user.id,
    )
    db.add(row)
    await db.flush()

    db.add(
        ActivityLog(
            actor_id=current_user.id,
            action=ActivityAction.FEATURE_VERSIONED,
            entity_type="feature",
            entity_id=feature_id,
            payload={
                "version_id": str(row.id),
                "version_number": next_version,
                "storage_key": storage_key,
                "filename": file.filename,
                "change_note": change_note,
                "action_string": f"feature:versioned→v{next_version}",
            },
        )
    )

    return FeatureVersionOut.model_validate(row)


@router.get(
    "/{feature_id}/versions",
    response_model=list[FeatureVersionOut],
    dependencies=[Depends(require_any)],
)
async def list_feature_versions(
    feature_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[FeatureVersionOut]:
    rows = (
        await db.execute(
            select(FeatureVersion)
            .where(FeatureVersion.feature_id == feature_id)
            .order_by(FeatureVersion.version.desc())
        )
    ).scalars().all()
    return [FeatureVersionOut.model_validate(r) for r in rows]


# ---------------------------------------------------------------------------
# GET /api/v1/features/{feature_id}/activity
# ---------------------------------------------------------------------------
@router.get(
    "/{feature_id}/activity",
    response_model=list[ActivityOut],
    dependencies=[Depends(require_any)],
    summary="Immutable activity timeline for a feature (newest first)",
)
async def feature_activity_timeline(
    feature_id: uuid.UUID,
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> list[ActivityOut]:
    feature_id_str = str(feature_id)
    sql = text(
        """
        SELECT
            a.id, a.actor_id, u.name AS actor_name, a.action,
            a.entity_type, a.entity_id, a.payload, a.created_at
        FROM activity_log a
        LEFT JOIN users u ON u.id = a.actor_id
        WHERE
            (a.entity_type = 'feature' AND a.entity_id = :fid)
            OR (a.payload ->> 'feature_id' = :fid_text)
        ORDER BY a.created_at DESC
        LIMIT :limit
        """
    )
    result = await db.execute(
        sql, {"fid": feature_id, "fid_text": feature_id_str, "limit": limit}
    )
    rows = result.mappings().all()

    return [
        ActivityOut(
            id=r["id"],
            actor_id=r["actor_id"],
            actor_name=r["actor_name"],
            action=r["action"],
            entity_type=r["entity_type"],
            entity_id=r["entity_id"],
            payload=r["payload"] or {},
            created_at=r["created_at"],
        )
        for r in rows
    ]

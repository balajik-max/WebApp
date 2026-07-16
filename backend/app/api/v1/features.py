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
    Response,
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
from app.services.attribute_table import (
    order_attribute_columns,
    populated_attribute_column_count,
    resolve_feature_fid,
)
from app.services.storage import ensure_bucket, upload_stream

log = logging.getLogger("davangere.api.features")
router = APIRouter()

_HARD_ROW_LIMIT = 5000
_DEFAULT_ROW_LIMIT = 2000


@router.get(
    "/fid-search",
    dependencies=[Depends(require_any)],
    summary="Search source FIDs for direct map navigation",
)
async def search_feature_fids(
    q: str = Query(min_length=1, max_length=64),
    ward: str | None = Query(default=None, max_length=128),
    dataset_id: list[uuid.UUID] | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return lightweight, unambiguous FID matches for the map top bar."""
    normalized = q.strip()
    if not normalized:
        return {"results": []}

    fid_expression = """
        COALESCE(
            f.attributes ->> 'FID',
            f.attributes ->> 'fid',
            f.attributes ->> 'OBJECTID',
            f.attributes ->> 'objectid'
        )
    """
    conditions = [f"{fid_expression} ILIKE :pattern"]
    params: dict[str, Any] = {"pattern": f"%{normalized}%", "exact": normalized, "limit": limit}
    if ward:
        conditions.append("d.ward = :ward")
        params["ward"] = ward
    if dataset_id:
        conditions.append("f.dataset_id = ANY(:dataset_ids)")
        params["dataset_ids"] = dataset_id

    result = await db.execute(
        text(
            f"""
            SELECT
                f.id::text AS id,
                f.dataset_id::text AS dataset_id,
                d.name AS dataset_name,
                {fid_expression} AS fid,
                COALESCE(f.category, 'uncategorized') AS category,
                f.label AS label
            FROM features f
            JOIN datasets d ON d.id = f.dataset_id
            WHERE {' AND '.join(conditions)}
            ORDER BY
                CASE WHEN {fid_expression} = :exact THEN 0 ELSE 1 END,
                length({fid_expression}),
                {fid_expression},
                COALESCE(f.category, 'uncategorized')
            LIMIT :limit
            """
        ),
        params,
    )
    return {
        "results": [
            {
                "id": row["id"],
                "dataset_id": row["dataset_id"],
                "dataset_name": row["dataset_name"],
                "fid": row["fid"],
                "category": row["category"],
                "label": row["label"],
            }
            for row in result.mappings().all()
        ]
    }


@router.get(
    "/categories",
    dependencies=[Depends(require_any)],
    summary="Distinct feature categories with counts (for filter dropdowns)",
)
async def list_categories(
    ward: str | None = Query(default=None, max_length=128),
    dataset_id: list[uuid.UUID] | None = Query(
        default=None,
        description="Restrict categories to one or more datasets. Repeat for multiple values.",
    ),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from app.models import Dataset

    category_expr = func.coalesce(func.nullif(func.trim(Feature.category), ""), "uncategorized")
    stmt = select(category_expr.label("category"), func.count(Feature.id).label("count")).where(
        Feature.category.is_distinct_from("raster_pixel")
    )
    if ward is not None:
        stmt = stmt.join(Dataset, Dataset.id == Feature.dataset_id).where(Dataset.ward == ward)
    if dataset_id:
        stmt = stmt.where(Feature.dataset_id.in_(list(dict.fromkeys(dataset_id))))
    stmt = stmt.group_by(category_expr).order_by(func.count(Feature.id).desc(), category_expr.asc())

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
# GET /api/v1/features/table
# ---------------------------------------------------------------------------
@router.get(
    "/table",
    dependencies=[Depends(require_any)],
    summary="Paginated attribute table for a filtered map layer",
)
async def map_layer_attribute_table(
    category: str = Query(
        ...,
        min_length=1,
        max_length=128,
        description="The map layer/category whose rows should be returned.",
    ),
    dataset_id: list[uuid.UUID] | None = Query(
        default=None,
        description="Restrict the table to the selected map datasets. Repeat for multiple datasets.",
    ),
    ward: str | None = Query(default=None, max_length=128),
    severity: float | None = Query(default=None, ge=0, le=1),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return raw stored attributes for exactly the layer visible on the map.

    Geometry is deliberately omitted so the table stays lightweight even for
    complex GDB polygons. Attribute columns are discovered across the entire
    filtered layer, not only the current page, so they remain stable while
    the user pages through the readings.
    """
    normalized_category = category.strip()
    if not normalized_category:
        raise HTTPException(status_code=400, detail="category must not be blank")

    conditions = ["COALESCE(f.category, 'uncategorized') = :category"]
    params: dict[str, Any] = {
        "category": normalized_category,
        "limit": limit,
        "offset": offset,
    }

    join_dataset = ward is not None
    if dataset_id:
        conditions.append("f.dataset_id = ANY(:dataset_ids)")
        params["dataset_ids"] = list(dict.fromkeys(dataset_id))
    if ward is not None:
        conditions.append("d.ward = :ward")
        params["ward"] = ward
    if severity is not None:
        conditions.append("f.severity >= :severity")
        params["severity"] = severity

    join_clause = "JOIN datasets d ON d.id = f.dataset_id" if join_dataset else ""
    where_clause = " AND ".join(conditions)

    total = (
        await db.execute(
            text(
                f"""
                SELECT COUNT(*)
                FROM features f
                {join_clause}
                WHERE {where_clause}
                """
            ),
            params,
        )
    ).scalar_one()

    column_rows = (
        await db.execute(
            text(
                f"""
                SELECT
                    keys.attribute_key,
                    COUNT(*) FILTER (
                        WHERE keys.attribute_value NOT IN (
                            'null'::jsonb, '""'::jsonb, '[]'::jsonb, '{{}}'::jsonb
                        )
                    ) AS populated_count
                FROM features f
                {join_clause}
                CROSS JOIN LATERAL jsonb_each(
                    COALESCE(f.attributes, '{{}}'::jsonb)
                ) AS keys(attribute_key, attribute_value)
                WHERE {where_clause}
                GROUP BY keys.attribute_key
                """
            ),
            params,
        )
    ).all()

    rows = (
        await db.execute(
            text(
                f"""
                WITH ranked_features AS (
                    SELECT
                        source_feature.*,
                        ROW_NUMBER() OVER (
                            PARTITION BY source_feature.dataset_id
                            ORDER BY source_feature.created_at, source_feature.id
                        ) AS generated_fid
                    FROM features source_feature
                )
                SELECT
                    f.id::text AS id,
                    f.label AS label,
                    f.category AS category,
                    f.severity AS severity,
                    f.attributes AS attributes,
                    f.generated_fid AS generated_fid
                FROM ranked_features f
                {join_clause}
                WHERE {where_clause}
                ORDER BY f.dataset_id, f.generated_fid
                LIMIT :limit OFFSET :offset
                """
            ),
            params,
        )
    ).mappings().all()

    return {
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "columns": order_attribute_columns(column_rows),
        "populated_column_count": populated_attribute_column_count(column_rows),
        "rows": [
            {
                "id": row["id"],
                "fid": resolve_feature_fid(row["attributes"], int(row["generated_fid"])),
                "label": row["label"],
                "category": row["category"],
                "severity": row["severity"],
                "attributes": row["attributes"] or {},
            }
            for row in rows
        ],
    }


# ---------------------------------------------------------------------------
# GET /api/v1/features
# ---------------------------------------------------------------------------
@router.get(
    "",
    dependencies=[Depends(require_any)],
    summary="Viewport-filtered features as GeoJSON",
)
async def list_features_in_viewport(
    bbox: str | None = Query(default=None, description="minLon,minLat,maxLon,maxLat (WGS84)"),
    ward: str | None = Query(default=None, max_length=128),
    category: list[str] | None = Query(
        default=None,
        description="Restrict to one or more categories. Repeat the parameter for multiple values.",
    ),
    severity: int | None = Query(default=None, description="Minimum severity threshold"),
    severity_bucket: list[str] | None = Query(
        default=None,
        description="Optional Analytics cross-filter. Repeat low, medium, or high.",
    ),
    dataset_id: list[uuid.UUID] | None = Query(
        default=None,
        description=(
            "Restrict to one or more datasets (used by the map's dataset-click "
            "isolation / multi-dataset selection). Repeat the param for more than one."
        ),
    ),
    feature_ids: list[uuid.UUID] | None = Query(
        default=None,
        alias="id",
        description="Fetch specific features by ID (bypasses bbox requirement). Repeat for multiple.",
    ),
    exclude_internal: bool = Query(
        default=False,
        description="Exclude internal raster sample rows. Used by the read-only Analytics map.",
    ),
    limit: int = Query(default=_DEFAULT_ROW_LIMIT, ge=1, le=_HARD_ROW_LIMIT),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    # When explicit feature IDs are supplied, skip the bbox requirement
    # and return those features directly — used by the AI highlight layer
    # to resolve coordinates for classified poles.
    if feature_ids:
        sql = text(
            """
        SELECT
            f.id::text                          AS id,
            f.dataset_id::text                  AS dataset_id,
            f.label                             AS label,
            f.category                          AS category,
            f.severity                          AS severity,
            f.attributes->>'_canonical_class'   AS canonical_class,
            f.attributes                        AS attributes,
            ST_AsGeoJSON(f.geom)::text          AS geom_json
        FROM features f
        WHERE f.id = ANY(:ids)
            LIMIT :limit
            """
        )
        result = await db.execute(sql, {"ids": feature_ids, "limit": limit})
        rows = result.mappings().all()
        features: list[dict[str, Any]] = []
        for row in rows:
            geometry = json.loads(row["geom_json"]) if row["geom_json"] else None
            features.append({
                "type": "Feature",
                "id": row["id"],
                "geometry": geometry,
                "properties": {
                    "id": row["id"],
                    "dataset_id": row["dataset_id"],
                    "label": row["label"],
                    "category": row["category"],
                    "severity": row["severity"],
                    "canonical_class": row["canonical_class"] or "Unclassified",
                    "attributes": row["attributes"] or {},
                },
            })
        return {
            "type": "FeatureCollection",
            "features": features,
            "bbox": [0, 0, 0, 0],
            "count": len(features),
            "limit": limit,
            "truncated": False,
        }

    if bbox is None:
        raise HTTPException(
            status_code=400,
            detail="Either bbox or id query parameter is required",
        )

    min_x, min_y, max_x, max_y = _parse_bbox(bbox)

    conditions = [
        "ST_Intersects(f.geom, ST_MakeEnvelope(:min_x, :min_y, :max_x, :max_y, 4326))"
    ]
    if exclude_internal:
        conditions.append("f.category IS DISTINCT FROM 'raster_pixel'")
    params: dict[str, Any] = {
        "min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y,
        "limit": limit,
    }

    join_dataset = ward is not None
    if ward is not None:
        conditions.append("d.ward = :ward")
        params["ward"] = ward
    if category:
        if any(len(value) > 128 for value in category):
            raise HTTPException(status_code=400, detail="category values must be at most 128 characters")
        # The category dropdown exposes NULL rows as "uncategorized", so use
        # the same coalescing here to make that option filter correctly.
        conditions.append("COALESCE(NULLIF(BTRIM(f.category), ''), 'uncategorized') = ANY(:categories)")
        params["categories"] = list(dict.fromkeys(category))
    if severity is not None:
        conditions.append("f.severity >= :severity")
        params["severity"] = float(severity)
    if severity_bucket:
        buckets = sorted({value.strip().lower() for value in severity_bucket if value.strip()})
        invalid_buckets = [value for value in buckets if value not in {"low", "medium", "high"}]
        if invalid_buckets:
            raise HTTPException(
                status_code=400,
                detail="severity_bucket must be one of low, medium, high",
            )
        bucket_conditions: list[str] = []
        if "low" in buckets:
            bucket_conditions.append("f.severity < 0.34")
        if "medium" in buckets:
            bucket_conditions.append("(f.severity >= 0.34 AND f.severity < 0.67)")
        if "high" in buckets:
            bucket_conditions.append("f.severity >= 0.67")
        if bucket_conditions:
            conditions.append("(" + " OR ".join(bucket_conditions) + ")")
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
            f.attributes->>'_canonical_class'   AS canonical_class,
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
                    "canonical_class": row["canonical_class"] or "Unclassified",
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


@router.get(
    "/{feature_id}/photo",
    dependencies=[Depends(require_any)],
    summary="Streams the original site-photo image for a geo-tagged photo feature",
)
async def feature_photo(feature_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> Response:
    row = (await db.execute(select(Feature).where(Feature.id == feature_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Feature not found")

    photo_key = (row.attributes or {}).get("photo_key")
    if not photo_key:
        raise HTTPException(status_code=404, detail="This feature has no attached photo")

    from app.services.storage import get_object_bytes

    try:
        image_bytes = await get_object_bytes(photo_key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Photo not found in storage") from exc

    content_type = (row.attributes or {}).get("content_type", "application/octet-stream")
    return Response(content=image_bytes, media_type=content_type)

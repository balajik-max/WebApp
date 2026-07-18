"""Universal dataset visualization, layer-review and dashboard endpoints."""
from __future__ import annotations

import io
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import StreamingResponse

from app.api.deps import require_any
from app.db.session import get_db
from app.models import Dataset, User
from app.schemas.visualization import (
    LayerReviewUpdate,
    UniversalDashboard,
    VisualizationManifest,
)
from app.services.visualization.excel_export import build_dataset_excel
from app.services.visualization.layer_classifier import DASHBOARD_TYPES
from app.services.visualization.manifest_builder import build_visualization_manifest
from app.services.visualization.universal_dashboard import build_universal_dashboard


router = APIRouter()


@router.get(
    "/dashboard-types",
    response_model=dict[str, str],
    dependencies=[Depends(require_any)],
    summary="List supported specialized and generic dashboard types",
)
async def dashboard_types() -> dict[str, str]:
    return DASHBOARD_TYPES


@router.get(
    "/datasets/{dataset_id}/manifest",
    response_model=VisualizationManifest,
    dependencies=[Depends(require_any)],
    summary="Build the universal layer inspection and review manifest",
)
async def dataset_visualization_manifest(
    dataset_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> VisualizationManifest:
    return await build_visualization_manifest(dataset_id, db)


@router.patch(
    "/datasets/{dataset_id}/layers/{layer_key}",
    response_model=VisualizationManifest,
    summary="Confirm or correct one detected layer classification",
)
async def update_layer_review(
    dataset_id: uuid.UUID,
    layer_key: str,
    body: LayerReviewUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_any),
) -> VisualizationManifest:
    manifest = await build_visualization_manifest(dataset_id, db)
    target = next((layer for layer in manifest.layers if layer.layer_key == layer_key), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Layer not found in this dataset")

    if body.dashboard_type is not None and body.dashboard_type not in DASHBOARD_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported dashboard type '{body.dashboard_type}'",
        )

    dataset = (
        await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    ).scalar_one_or_none()
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    metadata = dict(dataset.dataset_metadata or {})
    current_review = metadata.get("layer_review")
    review = dict(current_review) if isinstance(current_review, dict) else {}
    current_layer = review.get(layer_key)
    layer_config = dict(current_layer) if isinstance(current_layer, dict) else {}

    if body.display_name is not None:
        clean_name = body.display_name.strip()
        layer_config["display_name"] = clean_name or target.display_name
    if body.dashboard_type is not None:
        layer_config["dashboard_type"] = body.dashboard_type
    if body.included is not None:
        layer_config["included"] = body.included
    layer_config["confirmed"] = body.confirmed

    review[layer_key] = layer_config
    metadata["layer_review"] = review
    dataset.dataset_metadata = metadata
    await db.commit()

    return await build_visualization_manifest(dataset_id, db)


@router.get(
    "/datasets/{dataset_id}/dashboard",
    response_model=UniversalDashboard,
    dependencies=[Depends(require_any)],
    summary="Generate KPI, chart and field summaries for any reviewed dataset",
)
async def dataset_universal_dashboard(
    dataset_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> UniversalDashboard:
    return await build_universal_dashboard(dataset_id, db)




@router.get(
    "/datasets/{dataset_id}/records",
    dependencies=[Depends(require_any)],
    summary="Return lightweight attribute records for the approved dashboard UI",
)
async def dataset_dashboard_records(
    dataset_id: uuid.UUID,
    limit: int = Query(default=50000, ge=1, le=50000),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return attributes without geometry so the approved dashboard filters stay fast.

    Full-dataset KPI totals remain available from the universal dashboard endpoint.
    The record payload is used for the detailed filters and tables copied from the
    approved standalone dashboard.
    """
    dataset = (
        await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    ).scalar_one_or_none()
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    total = (
        await db.execute(
            text(
                """
                SELECT COUNT(*)::bigint
                FROM features
                WHERE dataset_id = :dataset_id
                  AND COALESCE(category, '') <> 'raster_pixel'
                """
            ),
            {"dataset_id": dataset_id},
        )
    ).scalar_one()

    rows = (
        await db.execute(
            text(
                """
                SELECT
                    id::text AS id,
                    COALESCE(category, 'uncategorized') AS category,
                    label,
                    severity,
                    REPLACE(ST_GeometryType(geom), 'ST_', '') AS geometry_type,
                    ST_X(ST_PointOnSurface(geom)) AS longitude,
                    ST_Y(ST_PointOnSurface(geom)) AS latitude,
                    COALESCE(attributes, '{}'::jsonb) AS attributes
                FROM features
                WHERE dataset_id = :dataset_id
                  AND COALESCE(category, '') <> 'raster_pixel'
                ORDER BY
                    COALESCE(attributes ->> 'gdb_layer', category, 'uncategorized'),
                    id
                LIMIT :limit
                """
            ),
            {"dataset_id": dataset_id, "limit": limit},
        )
    ).mappings().all()

    return {
        "dataset_id": str(dataset_id),
        "dataset_name": dataset.name,
        "total": int(total or 0),
        "limit": limit,
        "truncated": int(total or 0) > len(rows),
        "records": [
            {
                "id": row["id"],
                "category": row["category"],
                "label": row["label"],
                "severity": float(row["severity"] or 0),
                "geometry_type": row["geometry_type"] or "Unknown",
                "longitude": float(row["longitude"]) if row["longitude"] is not None else None,
                "latitude": float(row["latitude"]) if row["latitude"] is not None else None,
                "attributes": dict(row["attributes"] or {}),
            }
            for row in rows
        ],
    }


@router.get(
    "/datasets/{dataset_id}/export/excel",
    dependencies=[Depends(require_any)],
    summary="Export the reviewed dataset, layer report and attributes to Excel",
)
async def dataset_visualization_excel(
    dataset_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    payload, filename = await build_dataset_excel(dataset_id, db)
    disposition = f"attachment; filename*=UTF-8''{quote(filename)}"
    return StreamingResponse(
        io.BytesIO(payload),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": disposition},
    )

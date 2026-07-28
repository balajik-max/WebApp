"""Authenticated real-point LAS/LAZ visualization endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db
from app.models import Dataset, DatasetFileType, DatasetStatus
from app.services.lidar_point_cloud import ensure_lidar_point_artifact, public_manifest
from app.services.storage import get_object_bytes

router = APIRouter()


def _validate_dataset(row: Dataset | None) -> Dataset:
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if row.file_type not in {DatasetFileType.LIDAR, DatasetFileType.LAS}:
        raise HTTPException(status_code=400, detail="Dataset is not a LAS/LAZ point cloud")
    if row.status != DatasetStatus.READY:
        raise HTTPException(status_code=409, detail=f"Dataset is not ready (status={row.status.value})")
    if not row.storage_key:
        raise HTTPException(status_code=404, detail="Dataset source file is missing from storage")
    return row


async def _dataset(dataset_id: uuid.UUID, db: AsyncSession) -> Dataset:
    row = (await db.execute(select(Dataset).where(Dataset.id == dataset_id))).scalar_one_or_none()
    return _validate_dataset(row)


@router.get("/{dataset_id}/manifest", dependencies=[Depends(require_any)])
async def get_lidar_manifest(
    dataset_id: uuid.UUID,
    rebuild: bool = Query(False, description="Regenerate the cached point artifact"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    row = await _dataset(dataset_id, db)
    try:
        manifest = await ensure_lidar_point_artifact(
            dataset_id=str(dataset_id),
            storage_key=row.storage_key or "",
            size_bytes=row.size_bytes,
            force=rebuild,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Unable to prepare LiDAR point artifact: {exc}") from exc
    return public_manifest(manifest, dataset_id=str(dataset_id))


@router.get("/{dataset_id}/points.bin", dependencies=[Depends(require_any)])
async def get_lidar_points(
    dataset_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Response:
    row = await _dataset(dataset_id, db)
    try:
        manifest = await ensure_lidar_point_artifact(
            dataset_id=str(dataset_id),
            storage_key=row.storage_key or "",
            size_bytes=row.size_bytes,
        )
        try:
            payload = await get_object_bytes(str(manifest["binary_key"]))
        except Exception:  # noqa: BLE001 - repair a partial/stale cache once
            manifest = await ensure_lidar_point_artifact(
                dataset_id=str(dataset_id),
                storage_key=row.storage_key or "",
                size_bytes=row.size_bytes,
                force=True,
            )
            payload = await get_object_bytes(str(manifest["binary_key"]))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Unable to load LiDAR point artifact: {exc}") from exc

    expected = int(manifest["point_count"]) * int(manifest["record_stride_bytes"])
    if len(payload) != expected:
        raise HTTPException(status_code=500, detail="Cached LiDAR point artifact is incomplete")

    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "private, max-age=86400",
            "Content-Length": str(len(payload)),
            "X-Point-Count": str(manifest["point_count"]),
            "X-Record-Stride": str(manifest["record_stride_bytes"]),
        },
    )

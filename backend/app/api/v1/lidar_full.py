"""Authenticated experimental full-density LAS/LAZ endpoints."""
from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db
from app.models import Dataset, DatasetFileType, DatasetStatus
from app.services.lidar_full_point_cloud import (
    load_cached_full_manifest,
    public_full_manifest,
)
from app.services.storage import open_object_stream

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


async def _manifest(dataset_id: uuid.UUID, row: Dataset) -> dict:
    manifest = await load_cached_full_manifest(
        dataset_id=str(dataset_id),
        storage_key=row.storage_key or "",
        size_bytes=row.size_bytes,
    )
    if manifest is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "Full LiDAR artifact is not prepared. Run "
                "python generate_lidar_full_point_cloud.py <dataset> --force first."
            ),
        )
    return manifest


@router.get("/{dataset_id}/manifest", dependencies=[Depends(require_any)])
async def get_full_lidar_manifest(
    dataset_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    row = await _dataset(dataset_id, db)
    manifest = await _manifest(dataset_id, row)
    return public_full_manifest(manifest, dataset_id=str(dataset_id))


@router.get("/{dataset_id}/chunks/{chunk_index}.bin", dependencies=[Depends(require_any)])
async def get_full_lidar_chunk(
    dataset_id: uuid.UUID,
    chunk_index: int,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    row = await _dataset(dataset_id, db)
    manifest = await _manifest(dataset_id, row)
    chunks = manifest.get("chunks", [])
    match = next(
        (chunk for chunk in chunks if int(chunk.get("index", -1)) == chunk_index),
        None,
    )
    if match is None:
        raise HTTPException(status_code=404, detail="Point chunk not found")

    storage_key = str(match.get("storage_key") or "")
    if not storage_key:
        raise HTTPException(status_code=500, detail="Point chunk storage key is missing")

    try:
        response = await open_object_stream(storage_key)
        body = response["Body"]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Unable to open point chunk: {exc}") from exc

    async def iterator() -> AsyncIterator[bytes]:
        try:
            while True:
                payload = await asyncio.to_thread(body.read, 1024 * 1024)
                if not payload:
                    break
                yield payload
        finally:
            await asyncio.to_thread(body.close)

    byte_length = int(match["byte_length"])
    return StreamingResponse(
        iterator(),
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "private, max-age=86400",
            "Content-Length": str(byte_length),
            "X-Point-Count": str(match["point_count"]),
            "X-Record-Stride": str(manifest["record_stride_bytes"]),
            "X-Chunk-Index": str(chunk_index),
        },
    )

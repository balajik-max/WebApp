"""
Background ingestion orchestrator.

Called by `POST /api/v1/datasets/upload` via `FastAPI.BackgroundTasks`.
Downloads the object from MinIO to a scratch dir, dispatches to the
correct `DatasetReader`, and updates the `datasets` row + `activity_log`
throughout the lifecycle.
"""
from __future__ import annotations

import logging
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import (
    ActivityAction,
    ActivityLog,
    Dataset,
    DatasetStatus,
)
from app.services.readers import get_reader_for
from app.services.storage import download_to_file

log = logging.getLogger("davangere.ingestion")


async def _set_status(
    dataset_id: uuid.UUID,
    status: DatasetStatus,
    *,
    error: str | None = None,
    result_payload: dict | None = None,
) -> None:
    async with SessionLocal() as session:
        result = await session.execute(select(Dataset).where(Dataset.id == dataset_id))
        ds = result.scalar_one_or_none()
        if ds is None:
            log.warning("Dataset %s vanished before status update", dataset_id)
            return
        ds.status = status
        ds.processing_error = error
        if result_payload is not None:
            merged = dict(ds.dataset_metadata or {})
            merged["ingestion"] = result_payload
            ds.dataset_metadata = merged

        session.add(
            ActivityLog(
                actor_id=ds.uploaded_by,
                action=ActivityAction.DATASET_STATUS_CHANGED,
                entity_type="dataset",
                entity_id=ds.id,
                payload={
                    "status": status.value,
                    "error": error,
                    "at": datetime.now(timezone.utc).isoformat(),
                    **({"result": result_payload} if result_payload else {}),
                },
            )
        )
        await session.commit()


async def ingest_dataset(*, dataset_id: uuid.UUID, storage_key: str, filename: str) -> None:
    """Background pipeline: MinIO → local tmp → strategy reader → DB rows."""

    reader = get_reader_for(filename)
    if reader is None:
        await _set_status(
            dataset_id,
            DatasetStatus.FAILED,
            error=f"No reader can handle file '{filename}'",
        )
        return

    await _set_status(dataset_id, DatasetStatus.PROCESSING)

    with tempfile.TemporaryDirectory(prefix="ingest_") as tmpdir:
        local = Path(tmpdir) / filename
        try:
            await download_to_file(storage_key, local)
        except Exception as exc:  # noqa: BLE001
            log.exception("Failed to fetch %s from storage", storage_key)
            await _set_status(
                dataset_id,
                DatasetStatus.FAILED,
                error=f"storage_fetch_error: {exc}",
            )
            return

        try:
            result = await reader.read(local, str(dataset_id))
        except Exception as exc:  # noqa: BLE001
            log.exception("Reader failed for dataset %s", dataset_id)
            await _set_status(
                dataset_id,
                DatasetStatus.FAILED,
                error=f"reader_error: {exc}",
            )
            return

    await _set_status(
        dataset_id,
        DatasetStatus.READY,
        result_payload={
            "reader": reader.__class__.__name__,
            "inserted": result.inserted,
            "skipped": result.skipped,
            "source_crs": result.source_crs,
            "notes": result.notes,
        },
    )

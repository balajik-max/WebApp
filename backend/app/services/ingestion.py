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
from app.services.readers import DatasetReader, GISReader, ImageReader, ObjReader, get_reader_for
from app.services.spatial_audit import run_spatial_audit
from app.services.storage import download_to_file

log = logging.getLogger("davangere.ingestion")

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}
_GIS_EXTS = {".shp", ".dbf", ".shx", ".prj", ".gpkg"}
_OBJ_EXTS = {".obj"}
_PROCESSING_ERROR_MAX_LENGTH = 2048


def _pick_zip_reader(local_path: Path) -> DatasetReader:
    """A `.zip` could be a shapefile/GDB bundle, a batch of geo-tagged
    photos (a zipped folder of images, or several individually-selected
    photos zipped client-side), or a 3D model bundle (.obj + .mtl +
    textures, zipped client-side from a browsed folder) — peek at its real
    contents instead of assuming, since they all share the same extension."""
    import zipfile

    try:
        with zipfile.ZipFile(local_path) as zf:
            names = [n for n in zf.namelist() if not n.endswith("/")]
    except zipfile.BadZipFile:
        return GISReader()  # let the existing reader produce its own clear error

    has_obj = any(Path(n).suffix.lower() in _OBJ_EXTS for n in names)
    if has_obj:
        return ObjReader()
    has_gis = any(Path(n).suffix.lower() in _GIS_EXTS or ".gdb/" in n.lower() for n in names)
    if has_gis:
        return GISReader()
    has_images = any(Path(n).suffix.lower() in _IMAGE_EXTS for n in names)
    if has_images:
        return ImageReader()
    return GISReader()


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
        ds.processing_error = error[:_PROCESSING_ERROR_MAX_LENGTH] if error else None
        if result_payload is not None:
            merged = dict(ds.dataset_metadata or {})
            merged["ingestion"] = result_payload
            raster_overlay = result_payload.pop("raster_overlay", None)
            if raster_overlay is not None:
                merged["raster_overlay"] = raster_overlay
            model_assets = result_payload.pop("model_assets", None)
            if model_assets is not None:
                merged["model_assets"] = model_assets
            reader_metadata = result_payload.pop("dataset_metadata", None)
            if reader_metadata:
                merged.update(reader_metadata)
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
    """Background pipeline: MinIO → local tmp → strategy reader → DB rows.

    This runs fire-and-forget via `BackgroundTasks` after the HTTP response
    has already been sent — nothing surfaces an unhandled exception here to
    any client. Without the outer try/except, a failure in the PROCESSING
    or READY status writes themselves (DB blip, transient network issue)
    would propagate out uncaught and leave the dataset permanently stuck
    at its last-written status, potentially with rows already inserted by
    a successful reader run. The outer handler guarantees a FAILED status
    is always attempted as a last resort.
    """
    try:
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

            if local.suffix.lower() == ".zip":
                reader = _pick_zip_reader(local)

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
                "raster_overlay": result.raster_overlay,
                "model_assets": result.model_assets,
                "dataset_metadata": result.dataset_metadata,
            },
        )

        # Run the spatial audit (pole redundancy, drain encroachment,
        # manhole status, road width narrowing, powerline proximity) the
        # moment a GIS dataset is ready, so AI Detection findings already
        # exist the first time anyone opens this dataset — no more requiring
        # a user to click the AI icon before anomalies are computed. Only
        # GIS data has the surveyed geometry classes the audit needs; image
        # (site photos) and OBJ (3D model) uploads have nothing for it to
        # find, so skip them rather than paying for a no-op audit run.
        if isinstance(reader, GISReader):
            try:
                async with SessionLocal() as session:
                    await run_spatial_audit(dataset_id, session)
            except Exception:  # noqa: BLE001 — an audit failure must never
                # undo the READY status just written above; the dataset's
                # features are real and usable even if AI Detection isn't.
                log.exception("Automatic spatial audit failed for dataset %s", dataset_id)
    except Exception as exc:  # noqa: BLE001 — last-resort guard, see docstring
        log.exception("Unhandled error in ingest_dataset for %s", dataset_id)
        try:
            await _set_status(
                dataset_id,
                DatasetStatus.FAILED,
                error=f"unexpected_error: {exc}",
            )
        except Exception:  # noqa: BLE001
            log.exception(
                "Failed to record FAILED status for dataset %s — it will remain stuck",
                dataset_id,
            )

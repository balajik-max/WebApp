"""Isolated citizen dataset ingestion.

Citizen uploads are written to ``public_datasets`` and
``public_dataset_features``. They never enter the officer ``datasets`` or
``features`` tables, so existing maps, analytics, AI audits and remediation
workflows remain unchanged.
"""
from __future__ import annotations

import asyncio
import logging
import math
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
from geoalchemy2.shape import from_shape
from shapely import force_2d
from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.models import DatasetStatus, PublicDataset, PublicDatasetFeature
from app.services.readers.gis_reader import GISReader
from app.services.storage import download_to_file

log = logging.getLogger("davangere.public_dataset_ingestion")
_BATCH_SIZE = 500
_PROCESSING_ERROR_MAX_LENGTH = 2048


def _gdb_entry_path(zip_path: Path) -> str | None:
    """Return the full inner path to the single .gdb directory in a ZIP."""
    if zip_path.suffix.casefold() != ".zip":
        return None
    roots: set[str] = set()
    with zipfile.ZipFile(zip_path) as archive:
        for raw_name in archive.namelist():
            parts: list[str] = []
            for part in Path(raw_name.replace("\\", "/")).parts:
                parts.append(part)
                if part.casefold().endswith(".gdb"):
                    roots.add("/".join(parts))
                    break
    if not roots:
        return None
    if len(roots) != 1:
        raise ValueError("Archive must contain exactly one File Geodatabase")
    return next(iter(roots))


def _jsonable(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (str, int, bool, float)):
        return value
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:  # noqa: BLE001
            return str(value)
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    return str(value)


def _clean_text(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    text = " ".join(str(value).split())
    return text if text and text.casefold() != "nan" else None


def _attributes(row: pd.Series) -> dict[str, Any]:
    return {
        str(key): _jsonable(value)
        for key, value in row.items()
        if key != "geometry" and not str(key).startswith("_")
    }


def _find_column(columns: dict[str, str], candidates: tuple[str, ...]) -> str | None:
    return next((columns[name] for name in candidates if name in columns), None)


async def _set_status(
    dataset_id: uuid.UUID,
    status: DatasetStatus,
    *,
    error: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    async with SessionLocal() as session:
        row = (
            await session.execute(select(PublicDataset).where(PublicDataset.id == dataset_id))
        ).scalar_one_or_none()
        if row is None:
            return
        row.status = status
        row.processing_error = error[:_PROCESSING_ERROR_MAX_LENGTH] if error else None
        if metadata:
            merged = dict(row.dataset_metadata or {})
            merged["ingestion"] = metadata
            row.dataset_metadata = merged
        await session.commit()


async def _persist_features(dataset_id: uuid.UUID, frame: Any) -> tuple[int, int]:
    columns = {str(column).casefold(): str(column) for column in frame.columns if column != "geometry"}
    label_col = _find_column(
        columns,
        ("name", "label", "title", "feature_name", "asset_name", "objectid", "object_id", "id", "fid"),
    )
    category_col = _find_column(
        columns,
        (
            "category",
            "type",
            "class",
            "kind",
            "layer",
            "gdb_layer",
            "asset_type",
            "feature_type",
            "infrastructure_type",
            "road_type",
            "drain_type",
            "utility_type",
        ),
    )
    gdb_layer_col = columns.get("gdb_layer")

    inserted = 0
    skipped = 0
    batch: list[PublicDatasetFeature] = []

    async with SessionLocal() as session:
        await session.execute(
            delete(PublicDatasetFeature).where(PublicDatasetFeature.public_dataset_id == dataset_id)
        )
        for display_index, (_row_index, row) in enumerate(frame.iterrows(), start=1):
            geometry = row.get("geometry")
            if geometry is None or getattr(geometry, "is_empty", True):
                skipped += 1
                continue
            try:
                geometry = force_2d(geometry)
                if not geometry.is_valid:
                    geometry = geometry.buffer(0)
                if geometry.is_empty:
                    skipped += 1
                    continue
                label = _clean_text(row.get(label_col)) if label_col else None
                if label is None:
                    label = f"Feature {display_index}"
                category = _clean_text(row.get(category_col)) if category_col else None
                if category is None and gdb_layer_col:
                    category = _clean_text(row.get(gdb_layer_col))
                batch.append(
                    PublicDatasetFeature(
                        public_dataset_id=dataset_id,
                        geom=from_shape(geometry, srid=4326),
                        label=label[:255],
                        category=(category or "Uncategorized")[:128],
                        attributes=_attributes(row),
                    )
                )
            except Exception as exc:  # noqa: BLE001
                skipped += 1
                log.warning("Skipping public dataset feature %s: %s", display_index, exc)
                continue

            if len(batch) >= _BATCH_SIZE:
                session.add_all(batch)
                await session.flush()
                inserted += len(batch)
                batch.clear()

        if batch:
            session.add_all(batch)
            await session.flush()
            inserted += len(batch)
        await session.commit()
    return inserted, skipped


async def ingest_public_dataset(*, dataset_id: uuid.UUID, storage_key: str, filename: str) -> None:
    """Download and ingest a citizen vector dataset without officer-side effects."""
    try:
        await _set_status(dataset_id, DatasetStatus.PROCESSING)
        with tempfile.TemporaryDirectory(prefix="public_ingest_") as tmpdir:
            local_path = Path(tmpdir) / filename
            await download_to_file(storage_key, local_path)
            reader = GISReader()
            gdb_entry = _gdb_entry_path(local_path)
            if gdb_entry is not None:
                frame, source_crs = await asyncio.to_thread(reader._load_zipped_gdb, local_path, gdb_entry)
            else:
                frame, source_crs = await asyncio.to_thread(reader._load_geodataframe, local_path)
            inserted, skipped = await _persist_features(dataset_id, frame)
            if inserted == 0:
                raise ValueError("No usable map features were found in the uploaded dataset")

        await _set_status(
            dataset_id,
            DatasetStatus.READY,
            metadata={
                "reader": "PublicGISReader",
                "inserted": inserted,
                "skipped": skipped,
                "source_crs": source_crs,
                "processed_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Citizen dataset ingestion failed for %s", dataset_id)
        try:
            await _set_status(dataset_id, DatasetStatus.FAILED, error=f"reader_error: {exc}")
        except Exception:  # noqa: BLE001
            log.exception("Unable to record failed citizen dataset status for %s", dataset_id)

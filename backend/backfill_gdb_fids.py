"""Backfill true source FIDs for GDB datasets ingested before FID preservation.

Usage:
    docker compose exec -T backend python backfill_gdb_fids.py
    docker compose exec -T backend python backfill_gdb_fids.py <dataset-uuid>

The operation is idempotent and only adds ``attributes.FID``. Geometry,
categories, labels, readings, and all other stored values are left untouched.
"""
from __future__ import annotations

import asyncio
import logging
import sys
import tempfile
import uuid
from pathlib import Path

import geopandas as gpd
import pyogrio
from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import Dataset, Feature
from app.services.readers.gis_reader import _find_gdb_entry, _jsonable
from app.services.storage import download_to_file


logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("davangere.backfill-gdb-fids")


def _valid_source_fids(frame: gpd.GeoDataFrame) -> list[object]:
    result: list[object] = []
    for source_fid, geometry in zip(frame.index.to_list(), frame.geometry.to_list(), strict=True):
        if geometry is None or geometry.is_empty:
            continue
        result.append(_jsonable(source_fid))
    return result


async def _backfill_dataset(dataset: Dataset) -> tuple[int, int]:
    if not dataset.storage_key:
        return 0, 0

    updated = 0
    layers_seen = 0
    with tempfile.TemporaryDirectory(prefix="gdb-fid-backfill-") as temp_dir:
        archive = Path(temp_dir) / "source.zip"
        await download_to_file(dataset.storage_key, archive)
        gdb_entry = _find_gdb_entry(archive)
        if gdb_entry is None:
            return 0, 0

        source_path = f"/vsizip/{archive}/{gdb_entry}"
        async with SessionLocal() as session:
            for layer_name, _geometry_type in pyogrio.list_layers(source_path):
                frame = gpd.read_file(
                    source_path,
                    layer=layer_name,
                    engine="pyogrio",
                    fid_as_index=True,
                )
                source_fids = _valid_source_fids(frame)
                features = (
                    await session.execute(
                        select(Feature)
                        .where(
                            Feature.dataset_id == dataset.id,
                            Feature.attributes["gdb_layer"].as_string() == str(layer_name),
                        )
                        .order_by(Feature.created_at, Feature.id)
                    )
                ).scalars().all()

                if not features and not source_fids:
                    continue
                layers_seen += 1
                if len(features) != len(source_fids):
                    log.warning(
                        "Skipping %s / %s: database has %d rows but source has %d valid features",
                        dataset.name,
                        layer_name,
                        len(features),
                        len(source_fids),
                    )
                    continue

                for feature, source_fid in zip(features, source_fids, strict=True):
                    attributes = dict(feature.attributes or {})
                    existing = next(
                        (value for key, value in attributes.items() if key.casefold() == "fid"),
                        None,
                    )
                    if existing is not None:
                        continue
                    attributes["FID"] = source_fid
                    feature.attributes = attributes
                    updated += 1

            await session.commit()

    return updated, layers_seen


async def main() -> None:
    requested_id = uuid.UUID(sys.argv[1]) if len(sys.argv) > 1 else None
    async with SessionLocal() as session:
        stmt = select(Dataset).where(Dataset.storage_key.is_not(None)).order_by(Dataset.created_at)
        if requested_id is not None:
            stmt = stmt.where(Dataset.id == requested_id)
        datasets = (await session.execute(stmt)).scalars().all()

    total_updated = 0
    for dataset in datasets:
        updated, layers = await _backfill_dataset(dataset)
        if layers:
            log.info("%s: added FID to %d features across %d layers", dataset.name, updated, layers)
            total_updated += updated
    log.info("FID backfill complete: %d features updated", total_updated)


if __name__ == "__main__":
    asyncio.run(main())

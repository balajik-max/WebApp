"""Reprocess an existing OBJ dataset after model-rendering upgrades."""
from __future__ import annotations

import argparse
import asyncio
import tempfile
import uuid
import zipfile
from pathlib import Path

from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.models import Dataset, DatasetStatus, Feature
from app.services.readers.obj_reader import ObjReader
from app.services.storage import delete_objects_with_prefix, download_to_file, upload_stream


def _zip_source_directory(source: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(source).as_posix())


async def reprocess(dataset_id: uuid.UUID, source: Path | None = None) -> None:
    async with SessionLocal() as session:
        dataset = (
            await session.execute(select(Dataset).where(Dataset.id == dataset_id))
        ).scalar_one_or_none()
        if dataset is None:
            raise ValueError(f"Dataset {dataset_id} does not exist")
        if not dataset.storage_key:
            raise ValueError(f"Dataset {dataset_id} has no source object")
        filename = str((dataset.dataset_metadata or {}).get("original_filename") or Path(dataset.storage_key).name)
        old_feature_ids = list(
            (
                await session.execute(select(Feature.id).where(Feature.dataset_id == dataset_id))
            ).scalars()
        )
        storage_key = dataset.storage_key

    with tempfile.TemporaryDirectory(prefix="reprocess_obj_") as tmpdir:
        local_path = Path(tmpdir) / filename
        if source is not None:
            if source.is_dir():
                _zip_source_directory(source, local_path)
            elif source.is_file():
                local_path = source
            else:
                raise ValueError(f"Source path '{source}' does not exist")
            with local_path.open("rb") as stream:
                await upload_stream(stream, key=storage_key, content_type="application/zip")
        else:
            await download_to_file(storage_key, local_path)
        source_size = local_path.stat().st_size
        result = await ObjReader().read(local_path, str(dataset_id))

    async with SessionLocal() as session:
        dataset = (
            await session.execute(select(Dataset).where(Dataset.id == dataset_id))
        ).scalar_one()
        if old_feature_ids:
            await session.execute(delete(Feature).where(Feature.id.in_(old_feature_ids)))
        metadata = dict(dataset.dataset_metadata or {})
        metadata.update(result.dataset_metadata or {})
        metadata["ingestion"] = {
            "reader": "ObjReader",
            "inserted": result.inserted,
            "skipped": result.skipped,
            "source_crs": result.source_crs,
            "notes": result.notes,
        }
        dataset.dataset_metadata = metadata
        dataset.size_bytes = source_size
        dataset.status = DatasetStatus.READY
        dataset.processing_error = None
        await session.commit()

    print(
        f"Reprocessed {dataset_id}: inserted={result.inserted}, "
        f"skipped={result.skipped}, source_crs={result.source_crs}"
    )


async def cleanup_assets(dataset_id: uuid.UUID) -> None:
    async with SessionLocal() as session:
        dataset = (
            await session.execute(select(Dataset).where(Dataset.id == dataset_id))
        ).scalar_one()
        current_keys = set(
            (((dataset.dataset_metadata or {}).get("model_3d") or {}).get("asset_keys") or {}).values()
        )
    deleted = await delete_objects_with_prefix(
        f"datasets/{dataset_id}/model-assets/",
        keep=current_keys,
    )
    print(f"Removed {deleted} stale model assets for {dataset_id}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset_id", type=uuid.UUID)
    parser.add_argument("--source", type=Path, help="Complete OBJ folder or ZIP to replace the stored source")
    parser.add_argument("--cleanup-only", action="store_true")
    args = parser.parse_args()

    async def run() -> None:
        if not args.cleanup_only:
            await reprocess(args.dataset_id, args.source)
        await cleanup_assets(args.dataset_id)

    asyncio.run(run())


if __name__ == "__main__":
    main()

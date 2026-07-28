"""Warm/rebuild a real-point artifact for one LAS/LAZ dataset.

Usage inside the backend container:
    python generate_lidar_point_cloud.py cloud0
    python generate_lidar_point_cloud.py <dataset-uuid> --force
"""
from __future__ import annotations

import argparse
import asyncio
import uuid

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import Dataset, DatasetFileType, DatasetStatus
from app.services.lidar_point_cloud import ensure_lidar_point_artifact


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", help="Dataset name or UUID")
    parser.add_argument("--force", action="store_true", help="Rebuild even when a valid cache exists")
    args = parser.parse_args()

    async with SessionLocal() as session:
        try:
            dataset_uuid = uuid.UUID(args.dataset)
        except ValueError:
            dataset_uuid = None

        query = select(Dataset)
        if dataset_uuid is not None:
            query = query.where(Dataset.id == dataset_uuid)
        else:
            query = query.where(Dataset.name == args.dataset).order_by(Dataset.created_at.desc())
        row = (await session.execute(query)).scalars().first()

    if row is None:
        raise SystemExit(f"Dataset not found: {args.dataset}")
    if row.file_type not in {DatasetFileType.LIDAR, DatasetFileType.LAS}:
        raise SystemExit(f"Dataset is not LAS/LAZ: {row.name} ({row.file_type.value})")
    if row.status != DatasetStatus.READY:
        raise SystemExit(f"Dataset is not ready: {row.status.value}")
    if not row.storage_key:
        raise SystemExit("Dataset has no storage key")

    print(f"Dataset: {row.name} ({row.id})")
    print(f"Source: {row.storage_key}")
    print("Building real XYZ point artifact. Large files can take several minutes...")
    manifest = await ensure_lidar_point_artifact(
        dataset_id=str(row.id),
        storage_key=row.storage_key,
        size_bytes=row.size_bytes,
        force=args.force,
    )
    print(
        "Point artifact ready: "
        f"sampled={manifest['point_count']:,} / source={manifest['point_count_source']:,}, "
        f"mode={manifest['default_color_mode']}, stride={manifest['record_stride_bytes']} bytes"
    )
    print(f"Bounds: {manifest['bounds']}")


if __name__ == "__main__":
    asyncio.run(main())

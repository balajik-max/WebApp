"""Prepare every valid LAS/LAZ point as progressive WebGL chunks.

Usage inside the backend container:
    python generate_lidar_full_point_cloud.py cloud0 --force
"""
from __future__ import annotations

import argparse
import asyncio
import uuid

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import Dataset, DatasetFileType, DatasetStatus
from app.services.lidar_full_point_cloud import ensure_lidar_full_point_artifact


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", help="Dataset name or UUID")
    parser.add_argument("--force", action="store_true", help="Rebuild the complete chunk cache")
    parser.add_argument(
        "--chunk-points",
        type=int,
        default=250_000,
        help="Target points per progressive browser chunk",
    )
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
    print("Preparing every valid point in progressive chunks...")
    manifest = await ensure_lidar_full_point_artifact(
        dataset_id=str(row.id),
        storage_key=row.storage_key,
        size_bytes=row.size_bytes,
        force=args.force,
        chunk_points=args.chunk_points,
    )
    print(
        "Full point artifact ready: "
        f"points={manifest['point_count']:,} / source={manifest['point_count_source']:,}, "
        f"chunks={manifest['chunk_count']}, "
        f"bytes={manifest['estimated_binary_bytes']:,}"
    )
    print(f"Dropped invalid points: {manifest['dropped_invalid_points']:,}")
    print(f"Bounds: {manifest['bounds']}")


if __name__ == "__main__":
    asyncio.run(main())

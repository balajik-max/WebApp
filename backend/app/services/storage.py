"""
Object storage abstraction — MinIO in dev, drop-in S3 in production.

Wraps `boto3` (which is synchronous) with `asyncio.to_thread` so the
FastAPI event loop is never blocked on upload/download.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, BinaryIO

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.core.config import get_settings

log = logging.getLogger("davangere.storage")

_S3_KWARGS = {
    "config": Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
}


def _client():
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint_url,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        region_name=s.s3_region,
        **_S3_KWARGS,
    )


async def ensure_bucket() -> None:
    """Idempotent bucket creation — safe to call on every boot."""
    s = get_settings()

    def _do() -> None:
        client = _client()
        try:
            client.head_bucket(Bucket=s.s3_bucket)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code in ("404", "NoSuchBucket", "NotFound"):
                client.create_bucket(Bucket=s.s3_bucket)
                log.info("Created MinIO bucket %s", s.s3_bucket)
            else:
                raise

    await asyncio.to_thread(_do)


async def upload_stream(fileobj: BinaryIO, *, key: str, content_type: str | None = None) -> str:
    """Upload an open binary stream to the configured bucket. Returns the key."""
    s = get_settings()

    def _do() -> None:
        extra = {"ContentType": content_type} if content_type else {}
        _client().upload_fileobj(fileobj, s.s3_bucket, key, ExtraArgs=extra)

    await asyncio.to_thread(_do)
    return key


async def download_to_file(key: str, dest: Path) -> Path:
    """Download an object to a local path (used by ingestion pipelines)."""
    s = get_settings()

    def _do() -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        _client().download_file(s.s3_bucket, key, str(dest))

    await asyncio.to_thread(_do)
    return dest


async def get_object_bytes(key: str) -> bytes:
    """Fetch an object's full body. Used to serve small derived assets
    (e.g. raster preview PNGs) back through the API without exposing the
    internal MinIO endpoint to the browser."""
    s = get_settings()

    def _do() -> bytes:
        resp = _client().get_object(Bucket=s.s3_bucket, Key=key)
        return resp["Body"].read()

    return await asyncio.to_thread(_do)


async def open_object_stream(key: str) -> dict[str, Any]:
    """Open an object for chunked API proxying without buffering it.

    Large OBJ meshes can be hundreds of megabytes, so ``get_object_bytes``
    would duplicate the entire model in backend memory before the first byte
    reached the browser. The caller owns and must close the returned Body.
    """
    s = get_settings()

    def _do() -> dict[str, Any]:
        return _client().get_object(Bucket=s.s3_bucket, Key=key)

    return await asyncio.to_thread(_do)


async def delete_object(key: str) -> None:
    """Remove an object from the bucket. Safe to call even if it's already gone."""
    s = get_settings()

    def _do() -> None:
        try:
            _client().delete_object(Bucket=s.s3_bucket, Key=key)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code not in ("404", "NoSuchKey", "NotFound"):
                raise

    await asyncio.to_thread(_do)


async def delete_objects_with_prefix(prefix: str, *, keep: set[str] | None = None) -> int:
    """Delete objects under a dataset-owned prefix, optionally preserving keys."""
    s = get_settings()
    keep_keys = keep or set()

    def _do() -> int:
        client = _client()
        deleted = 0
        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=s.s3_bucket, Prefix=prefix):
            keys = [
                item["Key"] for item in page.get("Contents", [])
                if item["Key"] not in keep_keys
            ]
            for start in range(0, len(keys), 1000):
                batch = keys[start:start + 1000]
                if batch:
                    client.delete_objects(
                        Bucket=s.s3_bucket,
                        Delete={"Objects": [{"Key": key} for key in batch], "Quiet": True},
                    )
                    deleted += len(batch)
        return deleted

    return await asyncio.to_thread(_do)

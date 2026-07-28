"""Experimental full-density LAS/LAZ point artifacts.

This module is deliberately separate from the normal bounded point artifact.
It preserves the lightweight default renderer while allowing an operator to
prepare every valid LAS/LAZ point as progressive WebGL chunks for a controlled
stress test.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import tempfile
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from pyproj import CRS, Transformer

from app.services.storage import (
    delete_objects_with_prefix,
    download_to_file,
    get_object_bytes,
    upload_stream,
)

_FULL_ARTIFACT_VERSION = 1
_DEFAULT_CHUNK_POINTS = 250_000
_FULL_RECORD_DTYPE = np.dtype(
    [
        ("x", "<f4"),
        ("y", "<f4"),
        ("z", "<f4"),
        ("r", "u1"),
        ("g", "u1"),
        ("b", "u1"),
        ("classification", "u1"),
    ],
    align=False,
)

_LOCKS: dict[str, asyncio.Lock] = {}
_LOCKS_GUARD = asyncio.Lock()


@dataclass(slots=True)
class BuiltFullPointArtifact:
    manifest: dict[str, Any]
    chunk_paths: list[Path]


def artifact_prefix(dataset_id: str) -> str:
    return f"datasets/{dataset_id}/point-cloud-full-v{_FULL_ARTIFACT_VERSION}"


def manifest_key(dataset_id: str) -> str:
    return f"{artifact_prefix(dataset_id)}/manifest.json"


def chunk_key(dataset_id: str, index: int) -> str:
    return f"{artifact_prefix(dataset_id)}/chunk-{index:05d}.bin"


def _source_fingerprint(storage_key: str, size_bytes: int | None, chunk_points: int) -> str:
    raw = (
        f"{storage_key}|{size_bytes or 0}|full-v{_FULL_ARTIFACT_VERSION}|"
        f"chunk={chunk_points}|stride={_FULL_RECORD_DTYPE.itemsize}"
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


def _as_uint8_rgb(values: np.ndarray) -> np.ndarray:
    arr = np.asarray(values)
    if arr.size == 0:
        return np.zeros(0, dtype=np.uint8)
    max_value = int(np.max(arr))
    if max_value <= 255:
        return np.clip(arr, 0, 255).astype(np.uint8)
    return np.clip(np.rint(arr.astype(np.float64) / 257.0), 0, 255).astype(np.uint8)


def _default_mode(*, has_rgb: bool, has_classification: bool) -> str:
    if has_rgb:
        return "rgb"
    if has_classification:
        return "classification"
    return "elevation"


def build_lidar_full_point_artifact(
    file_path: Path,
    *,
    output_dir: Path,
    dataset_id: str,
    storage_key: str,
    size_bytes: int | None,
    chunk_points: int = _DEFAULT_CHUNK_POINTS,
) -> BuiltFullPointArtifact:
    """Write every valid source point into spatially distributed binary chunks.

    Global source indices are distributed round-robin across output chunks.
    This makes every progressively loaded chunk cover the complete survey area
    instead of revealing only one flightline at a time.
    """
    try:
        import laspy
    except ImportError as exc:  # pragma: no cover - deployment dependency
        raise RuntimeError("laspy is required for LAS/LAZ point rendering") from exc

    if chunk_points < 10_000:
        raise ValueError("chunk_points must be at least 10,000")

    output_dir.mkdir(parents=True, exist_ok=True)

    with laspy.open(file_path) as reader:
        header = reader.header
        source_count = int(header.point_count)
        if source_count <= 0:
            raise ValueError("LAS/LAZ file has no points")

        source_crs = header.parse_crs()
        if source_crs is None:
            raise ValueError(
                "The LAS/LAZ file has no embedded CRS. Assign a source CRS before enabling full point rendering."
            )

        dim_names = {str(name).lower() for name in header.point_format.dimension_names}
        has_rgb = {"red", "green", "blue"}.issubset(dim_names)
        has_classification = "classification" in dim_names

        transformer = Transformer.from_crs(
            CRS.from_user_input(source_crs),
            CRS.from_epsg(4326),
            always_xy=True,
        )

        mins = np.asarray(header.mins, dtype=np.float64)
        maxs = np.asarray(header.maxs, dtype=np.float64)
        center_x = float((mins[0] + maxs[0]) / 2.0)
        center_y = float((mins[1] + maxs[1]) / 2.0)
        origin_lon_raw, origin_lat_raw = transformer.transform(center_x, center_y)
        origin_lon = float(origin_lon_raw)
        origin_lat = float(origin_lat_raw)
        if not math.isfinite(origin_lon) or not math.isfinite(origin_lat):
            raise ValueError("CRS transformation produced an invalid point-cloud origin")

        z_base = float(mins[2])
        meters_per_degree_lat = 111_320.0
        meters_per_degree_lon = meters_per_degree_lat * math.cos(math.radians(origin_lat))
        if abs(meters_per_degree_lon) < 1e-9:
            raise ValueError("Point cloud is too close to a pole for this local rendering transform")

        output_chunk_count = max(1, math.ceil(source_count / chunk_points))
        paths = [output_dir / f"chunk-{index:05d}.bin" for index in range(output_chunk_count)]
        chunk_counts = [0 for _ in range(output_chunk_count)]

        class_counts: dict[str, int] = {}
        valid_total = 0
        seen_total = 0
        min_lon = math.inf
        min_lat = math.inf
        max_lon = -math.inf
        max_lat = -math.inf
        min_z = math.inf
        max_z = -math.inf

        with ExitStack() as stack:
            handles = [stack.enter_context(path.open("wb")) for path in paths]

            for source_chunk in reader.chunk_iterator(chunk_points):
                count = len(source_chunk)
                if count <= 0:
                    continue

                xs = np.asarray(source_chunk.x, dtype=np.float64)
                ys = np.asarray(source_chunk.y, dtype=np.float64)
                zs = np.asarray(source_chunk.z, dtype=np.float64)
                lons_raw, lats_raw = transformer.transform(xs, ys)
                lons = np.asarray(lons_raw, dtype=np.float64)
                lats = np.asarray(lats_raw, dtype=np.float64)

                valid = (
                    np.isfinite(lons)
                    & np.isfinite(lats)
                    & np.isfinite(zs)
                    & (lons >= -180.0)
                    & (lons <= 180.0)
                    & (lats >= -90.0)
                    & (lats <= 90.0)
                )
                valid_indices = np.flatnonzero(valid)
                if valid_indices.size == 0:
                    seen_total += count
                    continue

                lons = lons[valid]
                lats = lats[valid]
                zs = zs[valid]
                local_x = ((lons - origin_lon) * meters_per_degree_lon).astype(np.float32)
                local_y = ((lats - origin_lat) * meters_per_degree_lat).astype(np.float32)
                local_z = (zs - z_base).astype(np.float32)

                if has_rgb:
                    red = _as_uint8_rgb(np.asarray(source_chunk.red)[valid])
                    green = _as_uint8_rgb(np.asarray(source_chunk.green)[valid])
                    blue = _as_uint8_rgb(np.asarray(source_chunk.blue)[valid])
                else:
                    red = np.zeros(valid_indices.size, dtype=np.uint8)
                    green = np.zeros(valid_indices.size, dtype=np.uint8)
                    blue = np.zeros(valid_indices.size, dtype=np.uint8)

                if has_classification:
                    classifications = np.asarray(
                        source_chunk.classification,
                        dtype=np.uint8,
                    )[valid]
                    codes, counts = np.unique(classifications, return_counts=True)
                    for code, class_count in zip(codes, counts):
                        key = str(int(code))
                        class_counts[key] = class_counts.get(key, 0) + int(class_count)
                else:
                    classifications = np.zeros(valid_indices.size, dtype=np.uint8)

                records = np.zeros(valid_indices.size, dtype=_FULL_RECORD_DTYPE)
                records["x"] = local_x
                records["y"] = local_y
                records["z"] = local_z
                records["r"] = red
                records["g"] = green
                records["b"] = blue
                records["classification"] = classifications

                global_indices = seen_total + valid_indices.astype(np.int64)
                bucket_ids = np.mod(global_indices, output_chunk_count)
                for bucket in np.unique(bucket_ids):
                    bucket_index = int(bucket)
                    selected = records[bucket_ids == bucket]
                    handles[bucket_index].write(selected.tobytes(order="C"))
                    chunk_counts[bucket_index] += int(selected.shape[0])

                valid_total += int(valid_indices.size)
                seen_total += count
                min_lon = min(min_lon, float(np.min(lons)))
                min_lat = min(min_lat, float(np.min(lats)))
                max_lon = max(max_lon, float(np.max(lons)))
                max_lat = max(max_lat, float(np.max(lats)))
                min_z = min(min_z, float(np.min(zs)))
                max_z = max(max_z, float(np.max(zs)))

    if valid_total <= 0:
        raise ValueError("CRS transformation produced no valid longitude/latitude points")

    chunks: list[dict[str, Any]] = []
    for index, (path, count) in enumerate(zip(paths, chunk_counts)):
        byte_length = int(path.stat().st_size)
        expected = count * int(_FULL_RECORD_DTYPE.itemsize)
        if byte_length != expected:
            raise RuntimeError(
                f"Full point chunk {index} has {byte_length} bytes; expected {expected}"
            )
        chunks.append(
            {
                "index": index,
                "point_count": count,
                "byte_length": byte_length,
                "object_name": path.name,
            }
        )

    source_label = source_crs.to_string() if hasattr(source_crs, "to_string") else str(source_crs)
    manifest: dict[str, Any] = {
        "version": _FULL_ARTIFACT_VERSION,
        "mode": "experimental-full",
        "dataset_id": dataset_id,
        "source_key": storage_key,
        "source_size_bytes": size_bytes,
        "source_fingerprint": _source_fingerprint(storage_key, size_bytes, chunk_points),
        "source_crs": source_label,
        "point_count_source": source_count,
        "point_count": valid_total,
        "dropped_invalid_points": source_count - valid_total,
        "record_stride_bytes": int(_FULL_RECORD_DTYPE.itemsize),
        "chunk_points_target": chunk_points,
        "chunk_count": len(chunks),
        "estimated_binary_bytes": valid_total * int(_FULL_RECORD_DTYPE.itemsize),
        "origin": {
            "longitude": origin_lon,
            "latitude": origin_lat,
            "z_base_m": z_base,
        },
        "bounds": {
            "min_lon": min_lon,
            "min_lat": min_lat,
            "max_lon": max_lon,
            "max_lat": max_lat,
            "z_min_m": min_z,
            "z_max_m": max_z,
        },
        "has_rgb": has_rgb,
        "has_classification": has_classification,
        "classification_counts": class_counts,
        "default_color_mode": _default_mode(
            has_rgb=has_rgb,
            has_classification=has_classification,
        ),
        "chunks": chunks,
    }
    return BuiltFullPointArtifact(manifest=manifest, chunk_paths=paths)


async def _dataset_lock(dataset_id: str) -> asyncio.Lock:
    async with _LOCKS_GUARD:
        lock = _LOCKS.get(dataset_id)
        if lock is None:
            lock = asyncio.Lock()
            _LOCKS[dataset_id] = lock
        return lock


async def load_cached_full_manifest(
    *,
    dataset_id: str,
    storage_key: str,
    size_bytes: int | None,
    chunk_points: int = _DEFAULT_CHUNK_POINTS,
) -> dict[str, Any] | None:
    key = manifest_key(dataset_id)
    try:
        raw = await get_object_bytes(key)
        manifest = json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001 - missing/corrupt cache is a normal state
        return None
    if not isinstance(manifest, dict):
        return None
    if manifest.get("version") != _FULL_ARTIFACT_VERSION:
        return None
    if manifest.get("source_fingerprint") != _source_fingerprint(
        storage_key,
        size_bytes,
        chunk_points,
    ):
        return None
    if not isinstance(manifest.get("chunks"), list):
        return None
    manifest["manifest_key"] = key
    return manifest


async def ensure_lidar_full_point_artifact(
    *,
    dataset_id: str,
    storage_key: str,
    size_bytes: int | None,
    force: bool = False,
    chunk_points: int = _DEFAULT_CHUNK_POINTS,
) -> dict[str, Any]:
    if not force:
        cached = await load_cached_full_manifest(
            dataset_id=dataset_id,
            storage_key=storage_key,
            size_bytes=size_bytes,
            chunk_points=chunk_points,
        )
        if cached is not None:
            return cached

    lock = await _dataset_lock(dataset_id)
    async with lock:
        if not force:
            cached = await load_cached_full_manifest(
                dataset_id=dataset_id,
                storage_key=storage_key,
                size_bytes=size_bytes,
                chunk_points=chunk_points,
            )
            if cached is not None:
                return cached

        prefix = artifact_prefix(dataset_id)
        await delete_objects_with_prefix(prefix)

        suffix = Path(storage_key).suffix.lower() or ".las"
        with tempfile.TemporaryDirectory(prefix="lidar_full_points_") as tmpdir:
            root = Path(tmpdir)
            source_path = root / f"source{suffix}"
            output_dir = root / "chunks"
            await download_to_file(storage_key, source_path)
            built = await asyncio.to_thread(
                build_lidar_full_point_artifact,
                source_path,
                output_dir=output_dir,
                dataset_id=dataset_id,
                storage_key=storage_key,
                size_bytes=size_bytes,
                chunk_points=chunk_points,
            )

            for chunk, path in zip(built.manifest["chunks"], built.chunk_paths):
                key = chunk_key(dataset_id, int(chunk["index"]))
                with path.open("rb") as stream:
                    await upload_stream(
                        stream,
                        key=key,
                        content_type="application/octet-stream",
                    )
                chunk["storage_key"] = key

        key = manifest_key(dataset_id)
        await upload_stream(
            io.BytesIO(json.dumps(built.manifest, separators=(",", ":")).encode("utf-8")),
            key=key,
            content_type="application/json",
        )
        built.manifest["manifest_key"] = key
        return built.manifest


def public_full_manifest(manifest: dict[str, Any], *, dataset_id: str) -> dict[str, Any]:
    result = {
        key: value
        for key, value in manifest.items()
        if key not in {"manifest_key", "source_key"}
    }
    public_chunks: list[dict[str, Any]] = []
    for chunk in result.get("chunks", []):
        item = {
            key: value
            for key, value in chunk.items()
            if key not in {"storage_key", "object_name"}
        }
        item["url"] = f"/api/v1/lidar-full/{dataset_id}/chunks/{int(chunk['index'])}.bin"
        public_chunks.append(item)
    result["chunks"] = public_chunks
    return result

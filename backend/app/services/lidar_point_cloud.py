"""Derived real-point artifacts for LAS/LAZ map rendering.

The normal LiDAR reader intentionally keeps ingestion lightweight by storing
only a tiny feature sample plus an overview raster. This module builds a
separate, bounded WebGL-ready artifact from the original LAS/LAZ object.

The artifact is cached in object storage under the dataset's own prefix. It
contains actual sampled XYZ points, native RGB when present, classification,
intensity, and return number. No database schema changes are required.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from pyproj import CRS, Transformer

from app.services.storage import download_to_file, get_object_bytes, upload_stream

_ARTIFACT_VERSION = 1
_DEFAULT_MAX_POINTS = 600_000
_CHUNK_SIZE = 1_000_000
_RECORD_DTYPE = np.dtype(
    [
        ("x", "<f4"),
        ("y", "<f4"),
        ("z", "<f4"),
        ("r", "u1"),
        ("g", "u1"),
        ("b", "u1"),
        ("classification", "u1"),
        ("intensity", "<u2"),
        ("return_number", "u1"),
        ("reserved", "u1"),
    ],
    align=False,
)

# One lock per dataset prevents duplicate generation inside the same worker.
# Object-storage rechecks below also make concurrent workers converge safely.
_LOCKS: dict[str, asyncio.Lock] = {}
_LOCKS_GUARD = asyncio.Lock()


@dataclass(slots=True)
class BuiltPointArtifact:
    manifest: dict[str, Any]
    binary: bytes


def artifact_keys(dataset_id: str) -> tuple[str, str]:
    prefix = f"datasets/{dataset_id}/point-cloud-v{_ARTIFACT_VERSION}"
    return f"{prefix}/manifest.json", f"{prefix}/points.bin"


def _default_mode(*, has_rgb: bool, has_classification: bool, has_intensity: bool) -> str:
    if has_rgb:
        return "rgb"
    if has_classification:
        return "classification"
    if has_intensity:
        return "intensity"
    return "elevation"


def _source_fingerprint(storage_key: str, size_bytes: int | None) -> str:
    raw = f"{storage_key}|{size_bytes or 0}|v{_ARTIFACT_VERSION}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


def _as_uint8_rgb(values: np.ndarray) -> np.ndarray:
    """Normalize LAS color channels to uint8 without crushing 8-bit-in-16-bit files."""
    arr = np.asarray(values)
    if arr.size == 0:
        return np.zeros(0, dtype=np.uint8)
    max_value = int(np.max(arr))
    if max_value <= 255:
        return np.clip(arr, 0, 255).astype(np.uint8)
    # Standard LAS RGB uses 16-bit channels. Divide by 257 so 65535 -> 255.
    return np.clip(np.rint(arr.astype(np.float64) / 257.0), 0, 255).astype(np.uint8)


def _classification_counts(values: np.ndarray) -> dict[str, int]:
    if values.size == 0:
        return {}
    codes, counts = np.unique(values.astype(np.uint8), return_counts=True)
    return {str(int(code)): int(count) for code, count in zip(codes, counts)}


def build_lidar_point_artifact(
    file_path: Path,
    *,
    dataset_id: str,
    storage_key: str,
    size_bytes: int | None,
    max_points: int = _DEFAULT_MAX_POINTS,
) -> BuiltPointArtifact:
    """Build a deterministic, spatially distributed real-point artifact.

    The source is streamed with laspy. A global stride bounds memory and output
    size, then a deterministic shuffle ensures every draw-budget prefix covers
    the full survey area rather than only the first flightline/file segment.
    """
    try:
        import laspy
    except ImportError as exc:  # pragma: no cover - deployment dependency
        raise RuntimeError("laspy is required for LAS/LAZ point rendering") from exc

    if max_points < 1:
        raise ValueError("max_points must be positive")

    with laspy.open(file_path) as reader:
        header = reader.header
        point_count = int(header.point_count)
        if point_count <= 0:
            raise ValueError("LAS/LAZ file has no points")

        source_crs = header.parse_crs()
        if source_crs is None:
            raise ValueError(
                "The LAS/LAZ file has no embedded CRS. Assign a source CRS before enabling real point-cloud rendering."
            )

        dim_names = {str(name).lower() for name in header.point_format.dimension_names}
        has_rgb = {"red", "green", "blue"}.issubset(dim_names)
        has_classification = "classification" in dim_names
        has_intensity = "intensity" in dim_names
        has_return_number = "return_number" in dim_names

        stride = max(1, math.ceil(point_count / max_points))
        seen = 0
        sampled = 0

        xs_parts: list[np.ndarray] = []
        ys_parts: list[np.ndarray] = []
        zs_parts: list[np.ndarray] = []
        red_parts: list[np.ndarray] = []
        green_parts: list[np.ndarray] = []
        blue_parts: list[np.ndarray] = []
        class_parts: list[np.ndarray] = []
        intensity_parts: list[np.ndarray] = []
        return_parts: list[np.ndarray] = []

        for chunk in reader.chunk_iterator(_CHUNK_SIZE):
            n = len(chunk)
            offset = (-seen) % stride
            if offset >= n:
                seen += n
                continue
            indices = np.arange(offset, n, stride, dtype=np.int64)
            remaining = max_points - sampled
            if remaining <= 0:
                break
            if indices.size > remaining:
                indices = indices[:remaining]
            if indices.size == 0:
                seen += n
                continue

            xs_parts.append(np.asarray(chunk.x, dtype=np.float64)[indices])
            ys_parts.append(np.asarray(chunk.y, dtype=np.float64)[indices])
            zs_parts.append(np.asarray(chunk.z, dtype=np.float64)[indices])

            if has_rgb:
                red_parts.append(np.asarray(chunk.red)[indices])
                green_parts.append(np.asarray(chunk.green)[indices])
                blue_parts.append(np.asarray(chunk.blue)[indices])
            if has_classification:
                class_parts.append(np.asarray(chunk.classification, dtype=np.uint8)[indices])
            if has_intensity:
                intensity_parts.append(np.asarray(chunk.intensity, dtype=np.uint16)[indices])
            if has_return_number:
                return_parts.append(np.asarray(chunk.return_number, dtype=np.uint8)[indices])

            sampled += int(indices.size)
            seen += n

    if not xs_parts:
        raise ValueError("No valid points could be sampled from the LAS/LAZ file")

    xs = np.concatenate(xs_parts)
    ys = np.concatenate(ys_parts)
    zs = np.concatenate(zs_parts)

    transformer = Transformer.from_crs(CRS.from_user_input(source_crs), CRS.from_epsg(4326), always_xy=True)
    lons, lats = transformer.transform(xs, ys)
    lons = np.asarray(lons, dtype=np.float64)
    lats = np.asarray(lats, dtype=np.float64)

    valid = (
        np.isfinite(lons)
        & np.isfinite(lats)
        & np.isfinite(zs)
        & (lons >= -180.0)
        & (lons <= 180.0)
        & (lats >= -90.0)
        & (lats <= 90.0)
    )
    if not np.any(valid):
        raise ValueError("CRS transformation produced no valid longitude/latitude points")

    lons = lons[valid]
    lats = lats[valid]
    zs = zs[valid]

    def filtered(parts: list[np.ndarray], dtype: np.dtype[Any]) -> np.ndarray:
        if not parts:
            return np.zeros(lons.shape[0], dtype=dtype)
        return np.concatenate(parts)[valid].astype(dtype, copy=False)

    if has_rgb:
        red = _as_uint8_rgb(np.concatenate(red_parts)[valid])
        green = _as_uint8_rgb(np.concatenate(green_parts)[valid])
        blue = _as_uint8_rgb(np.concatenate(blue_parts)[valid])
    else:
        red = np.zeros(lons.shape[0], dtype=np.uint8)
        green = np.zeros(lons.shape[0], dtype=np.uint8)
        blue = np.zeros(lons.shape[0], dtype=np.uint8)

    classifications = filtered(class_parts, np.dtype("u1"))
    intensities = filtered(intensity_parts, np.dtype("<u2"))
    returns = filtered(return_parts, np.dtype("u1"))

    min_lon = float(np.min(lons))
    max_lon = float(np.max(lons))
    min_lat = float(np.min(lats))
    max_lat = float(np.max(lats))
    origin_lon = (min_lon + max_lon) / 2.0
    origin_lat = (min_lat + max_lat) / 2.0

    meters_per_degree_lat = 111_320.0
    meters_per_degree_lon = meters_per_degree_lat * math.cos(math.radians(origin_lat))
    z_base = float(np.min(zs))
    local_x = ((lons - origin_lon) * meters_per_degree_lon).astype(np.float32)
    local_y = ((lats - origin_lat) * meters_per_degree_lat).astype(np.float32)
    local_z = (zs - z_base).astype(np.float32)

    count = int(local_x.shape[0])
    # Stable shuffle means the first 25k/75k points are spread across the survey.
    seed = int(hashlib.sha256(dataset_id.encode("utf-8")).hexdigest()[:8], 16)
    order = np.random.default_rng(seed).permutation(count)

    records = np.zeros(count, dtype=_RECORD_DTYPE)
    records["x"] = local_x[order]
    records["y"] = local_y[order]
    records["z"] = local_z[order]
    records["r"] = red[order]
    records["g"] = green[order]
    records["b"] = blue[order]
    records["classification"] = classifications[order]
    records["intensity"] = intensities[order]
    records["return_number"] = returns[order]

    source_label = source_crs.to_string() if hasattr(source_crs, "to_string") else str(source_crs)
    fingerprint = _source_fingerprint(storage_key, size_bytes)
    manifest: dict[str, Any] = {
        "version": _ARTIFACT_VERSION,
        "dataset_id": dataset_id,
        "source_key": storage_key,
        "source_size_bytes": size_bytes,
        "source_fingerprint": fingerprint,
        "source_crs": source_label,
        "point_count_source": point_count,
        "point_count": count,
        "record_stride_bytes": int(_RECORD_DTYPE.itemsize),
        "layout": [
            {"name": "x", "type": "float32", "offset": 0},
            {"name": "y", "type": "float32", "offset": 4},
            {"name": "z", "type": "float32", "offset": 8},
            {"name": "r", "type": "uint8", "offset": 12},
            {"name": "g", "type": "uint8", "offset": 13},
            {"name": "b", "type": "uint8", "offset": 14},
            {"name": "classification", "type": "uint8", "offset": 15},
            {"name": "intensity", "type": "uint16", "offset": 16},
            {"name": "return_number", "type": "uint8", "offset": 18},
        ],
        "origin": {"longitude": origin_lon, "latitude": origin_lat, "z_base_m": z_base},
        "bounds": {
            "min_lon": min_lon,
            "min_lat": min_lat,
            "max_lon": max_lon,
            "max_lat": max_lat,
            "z_min_m": float(np.min(zs)),
            "z_max_m": float(np.max(zs)),
        },
        "has_rgb": has_rgb,
        "has_classification": has_classification,
        "has_intensity": has_intensity,
        "has_return_number": has_return_number,
        "classification_counts": _classification_counts(classifications),
        "intensity_min": int(np.min(intensities)) if has_intensity and intensities.size else 0,
        "intensity_max": int(np.max(intensities)) if has_intensity and intensities.size else 0,
        "default_color_mode": _default_mode(
            has_rgb=has_rgb,
            has_classification=has_classification,
            has_intensity=has_intensity,
        ),
        "draw_budgets": {
            "far": min(150_000, count),
            "medium": min(350_000, count),
            "close": min(600_000, count),
        },
    }
    return BuiltPointArtifact(manifest=manifest, binary=records.tobytes(order="C"))


async def _dataset_lock(dataset_id: str) -> asyncio.Lock:
    async with _LOCKS_GUARD:
        lock = _LOCKS.get(dataset_id)
        if lock is None:
            lock = asyncio.Lock()
            _LOCKS[dataset_id] = lock
        return lock


async def _load_cached_manifest(
    manifest_key: str,
    *,
    storage_key: str,
    size_bytes: int | None,
) -> dict[str, Any] | None:
    try:
        raw = await get_object_bytes(manifest_key)
        manifest = json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001 - cache miss/corruption regenerates safely
        return None
    if not isinstance(manifest, dict):
        return None
    if manifest.get("version") != _ARTIFACT_VERSION:
        return None
    if manifest.get("source_fingerprint") != _source_fingerprint(storage_key, size_bytes):
        return None
    return manifest


async def ensure_lidar_point_artifact(
    *,
    dataset_id: str,
    storage_key: str,
    size_bytes: int | None,
    force: bool = False,
    max_points: int = _DEFAULT_MAX_POINTS,
) -> dict[str, Any]:
    manifest_key, binary_key = artifact_keys(dataset_id)
    if not force:
        cached = await _load_cached_manifest(
            manifest_key,
            storage_key=storage_key,
            size_bytes=size_bytes,
        )
        if cached is not None:
            cached["manifest_key"] = manifest_key
            cached["binary_key"] = binary_key
            return cached

    lock = await _dataset_lock(dataset_id)
    async with lock:
        if not force:
            cached = await _load_cached_manifest(
                manifest_key,
                storage_key=storage_key,
                size_bytes=size_bytes,
            )
            if cached is not None:
                cached["manifest_key"] = manifest_key
                cached["binary_key"] = binary_key
                return cached

        suffix = Path(storage_key).suffix.lower() or ".las"
        with tempfile.TemporaryDirectory(prefix="lidar_points_") as tmpdir:
            local_path = Path(tmpdir) / f"source{suffix}"
            await download_to_file(storage_key, local_path)
            built = await asyncio.to_thread(
                build_lidar_point_artifact,
                local_path,
                dataset_id=dataset_id,
                storage_key=storage_key,
                size_bytes=size_bytes,
                max_points=max_points,
            )

        await upload_stream(
            io.BytesIO(built.binary),
            key=binary_key,
            content_type="application/octet-stream",
        )
        await upload_stream(
            io.BytesIO(json.dumps(built.manifest, separators=(",", ":")).encode("utf-8")),
            key=manifest_key,
            content_type="application/json",
        )
        built.manifest["manifest_key"] = manifest_key
        built.manifest["binary_key"] = binary_key
        return built.manifest


def public_manifest(manifest: dict[str, Any], *, dataset_id: str) -> dict[str, Any]:
    result = {k: v for k, v in manifest.items() if k not in {"manifest_key", "binary_key", "source_key"}}
    result["points_url"] = f"/api/v1/lidar/{dataset_id}/points.bin"
    return result

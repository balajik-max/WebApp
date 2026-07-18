"""
LASReader - LiDAR point clouds from `.las` and compressed `.laz` files.

The reader samples the cloud into a manageable set of point features for
map/table display, while preserving the point-cloud metadata on the
dataset row so the upload still carries useful bounds/format information.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import struct
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from geoalchemy2.shape import from_shape
from pyproj import Transformer
from shapely.geometry import Point

from app.db.session import SessionLocal
from app.models import Feature
from app.services.readers.base import ReaderResult

log = logging.getLogger("davangere.readers.las")

_LAS_SUFFIXES = {".las", ".laz"}
_MAX_SAMPLED_POINTS = 5000
_CHUNK_SIZE = 50_000
_DAVANGERE_CENTER_LON = 75.9932
_DAVANGERE_CENTER_LAT = 14.4644


@dataclass(slots=True, frozen=True)
class PointCloudPreview:
    payload: bytes
    point_count: int
    color_mode: str


def _dimension(chunk: Any, name: str) -> Any | None:
    """Read an optional LAS dimension without laspy raising for missing fields."""
    names = set(chunk.point_format.dimension_names)
    return getattr(chunk, name) if name in names else None


def build_point_cloud_preview(file_path: Path, max_points: int = 250_000) -> PointCloudPreview:
    """Build the compact XYZ/RGB stream consumed by the web 3D map layer.

    Header (40 bytes): ``NPC2``, uint32 count, then four float64 values:
    centre longitude/latitude and source minimum/maximum elevation. The body
    is GPU-ready structure-of-arrays: all xyz float32 values followed by all
    linear-RGB uint8 values. The browser can bind both views without copying
    or looping through millions of points.
    """
    try:
        import laspy
    except ImportError as exc:
        raise ValueError("laspy is required to preview LAS/LAZ files") from exc

    with laspy.open(file_path) as src:
        total = int(src.header.point_count or 0)
        if total <= 0:
            return PointCloudPreview(struct.pack("<4sIdddd", b"NPC2", 0, 0.0, 0.0, 0.0, 0.0), 0, "rgb")

        stride = max(1, math.ceil(total / max(1, max_points)))
        source_crs = None
        try:
            source_crs = src.header.parse_crs()
        except Exception:  # noqa: BLE001
            pass

        xs_parts: list[np.ndarray] = []
        ys_parts: list[np.ndarray] = []
        zs_parts: list[np.ndarray] = []
        rgb_parts: list[np.ndarray] = []
        global_offset = 0
        remaining = max_points

        for chunk in src.chunk_iterator(_CHUNK_SIZE):
            local = np.arange(len(chunk), dtype=np.int64)
            chosen = local[(local + global_offset) % stride == 0][:remaining]
            global_offset += len(chunk)
            if chosen.size == 0:
                continue

            xs_parts.append(np.asarray(chunk.x, dtype=np.float64)[chosen])
            ys_parts.append(np.asarray(chunk.y, dtype=np.float64)[chosen])
            zs_parts.append(np.asarray(chunk.z, dtype=np.float64)[chosen])

            red = _dimension(chunk, "red")
            green = _dimension(chunk, "green")
            blue = _dimension(chunk, "blue")
            if red is not None and green is not None and blue is not None:
                rgb_parts.append(np.column_stack((
                    np.asarray(red)[chosen], np.asarray(green)[chosen], np.asarray(blue)[chosen],
                )).astype(np.float64, copy=False))
            else:
                rgb_parts.append(np.zeros((chosen.size, 3), dtype=np.float64))

            remaining -= chosen.size
            if remaining <= 0:
                break

    xs = np.concatenate(xs_parts)
    ys = np.concatenate(ys_parts)
    zs = np.concatenate(zs_parts)
    rgb = np.concatenate(rgb_parts)

    transformer = None
    if source_crs is not None:
        try:
            transformer = Transformer.from_crs(source_crs, "EPSG:4326", always_xy=True)
        except Exception:  # noqa: BLE001
            pass
    if transformer is not None:
        lons, lats = transformer.transform(xs, ys)
    elif np.all((-180 <= xs) & (xs <= 180)) and np.all((-90 <= ys) & (ys <= 90)):
        lons, lats = xs, ys
    else:
        lons = _DAVANGERE_CENTER_LON + (xs - float(np.min(xs))) / 111_320.0
        lats = _DAVANGERE_CENTER_LAT + (ys - float(np.min(ys))) / 111_320.0

    valid = np.isfinite(lons) & np.isfinite(lats) & np.isfinite(zs)
    valid &= (-180 <= lons) & (lons <= 180) & (-90 <= lats) & (lats <= 90)
    lons, lats, zs, rgb = lons[valid], lats[valid], zs[valid], rgb[valid]
    count = int(len(zs))
    if count == 0:
        return PointCloudPreview(struct.pack("<4sIdddd", b"NPC2", 0, 0.0, 0.0, 0.0, 0.0), 0, "rgb")

    center_lon = float((np.min(lons) + np.max(lons)) / 2.0)
    center_lat = float((np.min(lats) + np.max(lats)) / 2.0)
    min_z, max_z = float(np.min(zs)), float(np.max(zs))
    east_m = (lons - center_lon) * (111_320.0 * math.cos(math.radians(center_lat)))
    north_m = (lats - center_lat) * 111_320.0

    has_rgb = bool(np.any(rgb > 0))
    if has_rgb:
        # LAS RGB is normally 16-bit, though some producers store 8-bit data.
        if float(np.max(rgb)) > 255.0:
            rgb = rgb / 257.0
        colors = np.clip(rgb, 0, 255).astype(np.uint8)
        color_mode = "rgb"
    else:
        normalized = np.zeros(count) if max_z <= min_z else (zs - min_z) / (max_z - min_z)
        # Terrain ramp: deep blue -> cyan -> green -> yellow -> red.
        stops = np.array([0.0, 0.25, 0.5, 0.75, 1.0])
        palette = np.array([[20, 72, 190], [20, 190, 220], [52, 190, 92], [245, 205, 55], [225, 55, 45]])
        colors = np.column_stack([np.interp(normalized, stops, palette[:, i]) for i in range(3)]).astype(np.uint8)
        color_mode = "elevation"

    # Three.js expects vertex colors in linear working space. Convert once,
    # vectorized on the backend, instead of looping over every point in JS.
    srgb = colors.astype(np.float32) / 255.0
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    linear_colors = np.clip(np.rint(linear * 255.0), 0, 255).astype(np.uint8)
    positions = np.column_stack((east_m, north_m, zs - min_z)).astype("<f4", copy=False)
    header = struct.pack("<4sIdddd", b"NPC2", count, center_lon, center_lat, min_z, max_z)
    return PointCloudPreview(header + positions.tobytes() + linear_colors.tobytes(), count, color_mode)


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
    return str(value)


def _sample_indices(total_points: int, max_points: int) -> set[int]:
    if total_points <= max_points:
        return set(range(total_points))
    if max_points <= 1:
        return {0}
    return {
        round(index * (total_points - 1) / (max_points - 1))
        for index in range(max_points)
    }


def _crs_to_string(crs: Any) -> str | None:
    if crs is None:
        return None
    try:
        authority = crs.to_authority()
        if authority:
            return f"{authority[0]}:{authority[1]}"
        return crs.to_string()
    except Exception:  # noqa: BLE001
        return str(crs)


@dataclass(slots=True)
class _SampledPoint:
    lon: float
    lat: float
    z: float
    attrs: dict[str, Any]


@dataclass(slots=True)
class _ParsedLas:
    points: list[_SampledPoint]
    skipped: int
    source_crs: str | None
    notes: str | None
    dataset_metadata: dict[str, Any]
    min_z: float
    max_z: float


class LasReader:
    """Handles `.las` and compressed `.laz` LiDAR point clouds."""

    def can_handle(self, filename: str) -> bool:
        return Path(filename).suffix.lower() in _LAS_SUFFIXES

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:
        parsed = await asyncio.to_thread(self._parse_sync, file_path)
        if not parsed.points:
            return ReaderResult(
                inserted=0,
                skipped=parsed.skipped,
                source_crs=parsed.source_crs,
                notes=parsed.notes,
                dataset_metadata=parsed.dataset_metadata,
            )
        return await self._persist(parsed, dataset_id=dataset_id)

    def _parse_sync(self, file_path: Path) -> _ParsedLas:
        try:
            import laspy
        except ImportError as exc:
            raise ValueError(
                "laspy is required to read LAS/LAZ files. Install it with: pip install -r requirements.txt"
            ) from exc

        with laspy.open(file_path) as src:
            header = src.header
            total_points = int(getattr(header, "point_count", 0) or 0)
            source_crs = None
            try:
                source_crs = _crs_to_string(header.parse_crs())
            except Exception:  # noqa: BLE001
                source_crs = None

            version = getattr(header, "version", None)
            point_format = getattr(getattr(header, "point_format", None), "id", None)
            mins = getattr(header, "mins", None)
            maxs = getattr(header, "maxs", None)
            scales = getattr(header, "scales", None)
            offsets = getattr(header, "offsets", None)

            bounds = None
            if mins is not None and maxs is not None and len(mins) >= 3 and len(maxs) >= 3:
                bounds = {
                    "min_x": float(mins[0]),
                    "min_y": float(mins[1]),
                    "min_z": float(mins[2]),
                    "max_x": float(maxs[0]),
                    "max_y": float(maxs[1]),
                    "max_z": float(maxs[2]),
                }

            dataset_metadata: dict[str, Any] = {
                "point_cloud": {
                    "point_count": total_points,
                    "sampled_points": 0,
                    "source_crs": source_crs,
                    "point_format": point_format,
                    "version": f"{getattr(version, 'major', '?')}.{getattr(version, 'minor', '?')}" if version else None,
                    "bounds": bounds,
                    "scales": [float(v) for v in scales] if scales is not None else None,
                    "offsets": [float(v) for v in offsets] if offsets is not None else None,
                }
            }

            if total_points == 0:
                return _ParsedLas(
                    points=[],
                    skipped=0,
                    source_crs=source_crs,
                    notes="LAS/LAZ file contains no points.",
                    dataset_metadata=dataset_metadata,
                    min_z=0.0,
                    max_z=0.0,
                )

            min_z = float(mins[2]) if mins is not None and len(mins) >= 3 else 0.0
            max_z = float(maxs[2]) if maxs is not None and len(maxs) >= 3 else min_z
            target_indices = _sample_indices(total_points, _MAX_SAMPLED_POINTS)
            transformer = None
            if source_crs:
                try:
                    transformer = Transformer.from_crs(source_crs, "EPSG:4326", always_xy=True)
                except Exception as exc:  # noqa: BLE001
                    log.warning("Could not build transformer for LAS %s (%s); falling back to a synthetic placement", file_path.name, exc)
                    transformer = None
            use_geographic = (
                transformer is None
                and mins is not None
                and maxs is not None
                and len(mins) >= 2
                and len(maxs) >= 2
                and -180.0 <= float(mins[0]) <= 180.0
                and -180.0 <= float(maxs[0]) <= 180.0
                and -90.0 <= float(mins[1]) <= 90.0
                and -90.0 <= float(maxs[1]) <= 90.0
            )

            points: list[_SampledPoint] = []
            skipped = 0
            global_index = 0
            for chunk in src.chunk_iterator(_CHUNK_SIZE):
                xs = chunk.x
                ys = chunk.y
                zs = chunk.z
                intensity = getattr(chunk, "intensity", None)
                return_number = getattr(chunk, "return_number", None)
                number_of_returns = getattr(chunk, "number_of_returns", None)
                classification = getattr(chunk, "classification", None)
                scan_angle = getattr(chunk, "scan_angle", getattr(chunk, "scan_angle_rank", None))
                user_data = getattr(chunk, "user_data", None)
                point_source_id = getattr(chunk, "point_source_id", None)
                gps_time = getattr(chunk, "gps_time", None)
                red = getattr(chunk, "red", None)
                green = getattr(chunk, "green", None)
                blue = getattr(chunk, "blue", None)

                for local_index, (x, y, z) in enumerate(zip(xs, ys, zs)):
                    if global_index not in target_indices:
                        global_index += 1
                        continue

                    if transformer is not None:
                        lon, lat = transformer.transform(float(x), float(y))
                        position_source = "header_crs"
                    elif use_geographic:
                        lon, lat = float(x), float(y)
                        position_source = "geographic"
                    else:
                        # Use a stable Davangere anchor when the LAS file has
                        # no declared CRS. This keeps the cloud visible in the
                        # browser while still making the fallback obvious in the
                        # stored metadata.
                        scale = 1.0 / 111_320.0
                        lon = _DAVANGERE_CENTER_LON + (float(x) - float(mins[0] if mins is not None and len(mins) >= 1 else 0.0)) * scale
                        lat = _DAVANGERE_CENTER_LAT + (float(y) - float(mins[1] if mins is not None and len(mins) >= 2 else 0.0)) * scale
                        position_source = "synthetic"

                    if math.isnan(lat) or math.isnan(lon):
                        skipped += 1
                        global_index += 1
                        continue
                    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                        skipped += 1
                        global_index += 1
                        continue

                    attrs = {
                        "las_file": file_path.name,
                        "point_index": global_index,
                        "point_count": total_points,
                        "x": _jsonable(x),
                        "y": _jsonable(y),
                        "z": _jsonable(z),
                        "intensity": _jsonable(intensity[local_index]) if intensity is not None else None,
                        "return_number": _jsonable(return_number[local_index]) if return_number is not None else None,
                        "number_of_returns": _jsonable(number_of_returns[local_index]) if number_of_returns is not None else None,
                        "classification": _jsonable(classification[local_index]) if classification is not None else None,
                        "scan_angle": _jsonable(scan_angle[local_index]) if scan_angle is not None else None,
                        "user_data": _jsonable(user_data[local_index]) if user_data is not None else None,
                        "point_source_id": _jsonable(point_source_id[local_index]) if point_source_id is not None else None,
                        "gps_time": _jsonable(gps_time[local_index]) if gps_time is not None else None,
                        "red": _jsonable(red[local_index]) if red is not None else None,
                        "green": _jsonable(green[local_index]) if green is not None else None,
                        "blue": _jsonable(blue[local_index]) if blue is not None else None,
                        "position_source": position_source,
                        "is_geo_referenced": position_source != "synthetic",
                    }
                    json.dumps(attrs)
                    points.append(_SampledPoint(lon=float(lon), lat=float(lat), z=float(z), attrs=attrs))
                    global_index += 1

            if total_points > len(points):
                dataset_metadata["point_cloud"]["sampled_points"] = len(points)
                note = f"Sampled {len(points):,} of {total_points:,} point-cloud points for map display."
            else:
                dataset_metadata["point_cloud"]["sampled_points"] = len(points)
                note = f"Loaded {total_points:,} point-cloud points."

            if source_crs is None:
                if use_geographic:
                    note = f"{note} No CRS was declared, but the coordinates already looked geographic."
                else:
                    note = f"{note} No CRS was declared, so the cloud was positioned with a synthetic Davangere anchor."

            return _ParsedLas(
                points=points,
                skipped=skipped,
                source_crs=source_crs,
                notes=note,
                dataset_metadata=dataset_metadata,
                min_z=min_z,
                max_z=max_z,
            )

    async def _persist(self, parsed: _ParsedLas, *, dataset_id: str) -> ReaderResult:
        dataset_uuid = uuid.UUID(dataset_id)
        inserted = 0
        batch: list[Feature] = []

        async with SessionLocal() as session:
            for point in parsed.points:
                attrs = dict(point.attrs)
                attrs["normalized_z"] = 0.0 if parsed.max_z <= parsed.min_z else max(
                    0.0,
                    min(1.0, (point.z - parsed.min_z) / (parsed.max_z - parsed.min_z)),
                )
                json.dumps(attrs)

                batch.append(
                    Feature(
                        dataset_id=dataset_uuid,
                        label=f"Point {point.attrs['point_index'] + 1}",
                        category="las_point",
                        severity=float(attrs["normalized_z"]),
                        attributes=attrs,
                        geom=from_shape(Point(point.lon, point.lat), srid=4326),
                    )
                )
                inserted += 1

                if len(batch) >= _CHUNK_SIZE:
                    session.add_all(batch)
                    await session.flush()
                    batch.clear()

            if batch:
                session.add_all(batch)
                await session.flush()

            await session.commit()

        log.info(
            "LasReader ingested dataset_id=%s inserted=%d skipped=%d source_crs=%s",
            dataset_id,
            inserted,
            parsed.skipped,
            parsed.source_crs,
        )
        return ReaderResult(
            inserted=inserted,
            skipped=parsed.skipped,
            source_crs=parsed.source_crs,
            notes=parsed.notes,
            dataset_metadata=parsed.dataset_metadata,
        )

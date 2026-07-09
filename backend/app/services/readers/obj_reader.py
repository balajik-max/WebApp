"""
ObjReader — Wavefront OBJ (.obj) 3D model files.

Parses vertex data from OBJ files and creates PostGIS POINT features at
each vertex location. Extracts vertex coordinates (X, Y, Z), face counts,
material references, and group information. Useful for 3D city models,
building models, and architectural survey data.

Note: OBJ files are local coordinate systems. If a separate MTL or PRJ
file provides georeferencing, that could be used. By default, vertices
are stored with their raw coordinates and a synthetic bounding box is
computed for map display.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from geoalchemy2.shape import from_shape
from shapely.geometry import Point

from app.db.session import SessionLocal
from app.models import Feature
from app.services.readers.base import ReaderResult

log = logging.getLogger("davangere.readers.obj")

_OBJ_SUFFIXES = {".obj"}
_BATCH_SIZE = 500
_MAX_VERTICES = 500  # Max vertices to extract


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


@dataclass(slots=True)
class _ParsedObj:
    vertices: list[tuple[float, float, float]]
    groups: list[str]
    materials: list[str]
    vertex_count: int
    face_count: int
    filename: str
    skipped: int = 0
    bbox: dict[str, float] = field(default_factory=dict)


class ObjReader:
    """Handles Wavefront OBJ 3D model inputs."""

    def can_handle(self, filename: str) -> bool:
        return Path(filename).suffix.lower() in _OBJ_SUFFIXES

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:
        parsed = await asyncio.to_thread(self._parse_sync, file_path)
        if not parsed.vertices:
            return ReaderResult(inserted=0, skipped=parsed.skipped, source_crs=None, notes="No valid vertices found")
        return await self._persist(parsed, dataset_id=dataset_id)

    def _parse_sync(self, file_path: Path) -> _ParsedObj:
        vertices: list[tuple[float, float, float]] = []
        groups: list[str] = []
        materials: list[str] = []
        current_group: str | None = None
        vertex_count = 0
        face_count = 0
        skipped = 0

        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue

                parts = line.split(None, 1)
                if len(parts) < 2:
                    continue

                prefix, data = parts[0], parts[1]

                if prefix == "v":  # Vertex
                    try:
                        coords = data.split()[:3]
                        x, y, z = float(coords[0]), float(coords[1]), float(coords[2])
                        vertices.append((x, y, z))
                        vertex_count += 1
                    except (ValueError, IndexError):
                        skipped += 1

                elif prefix == "f":  # Face
                    face_count += 1

                elif prefix == "g":  # Group
                    current_group = data.strip()
                    groups.append(current_group)

                elif prefix == "mtllib":  # Material library
                    materials.append(data.strip())

        bbox: dict[str, float] = {}
        if vertices:
            xs = [v[0] for v in vertices]
            ys = [v[1] for v in vertices]
            zs = [v[2] for v in vertices]
            bbox = {
                "min_x": min(xs), "max_x": max(xs),
                "min_y": min(ys), "max_y": max(ys),
                "min_z": min(zs), "max_z": max(zs),
            }

        return _ParsedObj(
            vertices=vertices[:_MAX_VERTICES],
            groups=groups,
            materials=materials,
            vertex_count=vertex_count,
            face_count=face_count,
            filename=file_path.name,
            skipped=skipped,
            bbox=bbox,
        )

    async def _persist(self, parsed: _ParsedObj, *, dataset_id: str) -> ReaderResult:
        dataset_uuid = uuid.UUID(dataset_id)
        inserted = 0
        skipped = parsed.skipped
        bbox = parsed.bbox
        center_x = (bbox["min_x"] + bbox["max_x"]) / 2
        center_y = (bbox["min_y"] + bbox["max_y"]) / 2
        center_z = (bbox["min_z"] + bbox["max_z"]) / 2

        # If coordinates look like lat/lon (within valid range), use them
        # directly; otherwise synthesize a mapping centered on Davangere so
        # the model still renders somewhere sensible on the map.
        sample = parsed.vertices[:10]
        use_geo_coords = (
            all(-180 <= x <= 180 for x, _, _ in sample) and
            all(-90 <= y <= 90 for _, y, _ in sample)
        )
        log.info(
            "OBJ %s: %s coordinates",
            parsed.filename,
            "geographic" if use_geo_coords else "local (synthetic mapping)",
        )

        batch: list[Feature] = []
        async with SessionLocal() as session:
            for idx, (x, y, z) in enumerate(parsed.vertices):
                if use_geo_coords:
                    lon, lat = x, y
                else:
                    dav_lat, dav_lon = 14.4644, 76.9281
                    scale = 0.0001
                    lon = dav_lon + (x - center_x) * scale
                    lat = dav_lat + (y - center_y) * scale

                if math.isnan(lat) or math.isnan(lon):
                    skipped += 1
                    continue
                if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                    skipped += 1
                    continue

                attrs = {
                    "obj_file": parsed.filename,
                    "vertex_index": idx,
                    "x": _jsonable(x),
                    "y": _jsonable(y),
                    "z": _jsonable(z),
                    "total_vertices": parsed.vertex_count,
                    "total_faces": parsed.face_count,
                    "groups": parsed.groups[:10],
                    "materials": parsed.materials[:5],
                    "bounding_box": bbox,
                    "center": {"x": center_x, "y": center_y, "z": center_z},
                    "is_geo_referenced": use_geo_coords,
                }
                json.dumps(attrs)  # fail fast on non-serializable content

                label = f"Vertex {idx + 1}"

                severity_val = 0.0
                if bbox["max_z"] > bbox["min_z"]:
                    severity_val = max(0.0, min(1.0, (z - bbox["min_z"]) / (bbox["max_z"] - bbox["min_z"])))

                batch.append(
                    Feature(
                        dataset_id=dataset_uuid,
                        label=label,
                        category="3d_vertex",
                        severity=severity_val,
                        attributes=attrs,
                        geom=from_shape(Point(lon, lat), srid=4326),
                    )
                )
                inserted += 1

                if len(batch) >= _BATCH_SIZE:
                    session.add_all(batch)
                    await session.flush()
                    batch.clear()

            if batch:
                session.add_all(batch)
                await session.flush()

            await session.commit()

        log.info(
            "ObjReader ingested dataset_id=%s inserted=%d skipped=%d vertices=%d faces=%d",
            dataset_id,
            inserted,
            skipped,
            parsed.vertex_count,
            parsed.face_count,
        )
        return ReaderResult(
            inserted=inserted,
            skipped=skipped,
            source_crs="LOCAL" if not use_geo_coords else "EPSG:4326",
            notes=f"vertices={parsed.vertex_count}, faces={parsed.face_count}, groups={len(parsed.groups)}",
        )

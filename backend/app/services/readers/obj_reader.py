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
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from geoalchemy2.shape import from_shape
from pyproj import Transformer
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


_MTL_SUFFIXES = {".mtl"}
_TEXTURE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif"}


@dataclass(slots=True, frozen=True)
class _GeoOrigin:
    """The real-world anchor for an OBJ's local vertex coordinates, as
    declared by a ContextCapture/Bentley-style `metadata.xml` sibling —
    every vertex (x, y, z) in the mesh is a metre offset from this point,
    in this CRS."""
    crs: str
    x: float
    y: float
    z: float


def _sample_vertices(
    vertices: list[tuple[float, float, float]], max_count: int
) -> list[tuple[float, float, float]]:
    """An OBJ's vertices are written in mesh-traversal order, not spatial
    order — for a real 1.3M-vertex, ~420m-wide survey block, the first 500
    vertices (the naive truncation this replaced) spanned barely 28m, one
    small corner of the model. That renders as a tiny, misleadingly-placed
    blob instead of the model's actual footprint. Take an even stride
    across the whole list instead, so the capped sample still spreads
    across the full extent.
    """
    if len(vertices) <= max_count:
        return vertices
    step = len(vertices) / max_count
    return [vertices[int(i * step)] for i in range(max_count)]


def _find_geo_origin(root: Path) -> _GeoOrigin | None:
    """Scans a bundle (already-extracted zip) for a tiled-mesh metadata.xml
    giving the OBJ's real-world anchor. Without this, a photogrammetry
    export's local meter offsets carry no absolute position at all — the
    caller falls back to guessing, which is exactly the "wrong location"
    bug this fixes. The file conventionally sits *above* the model's own
    folder (sibling to it, not inside it), so this always searches the
    whole extracted tree rather than just the .obj's own directory.
    """
    for xml_file in root.rglob("*.xml"):
        try:
            tree_root = ET.parse(xml_file).getroot()
        except ET.ParseError:
            continue
        srs_el = tree_root.find(".//SRS")
        origin_el = tree_root.find(".//SRSOrigin")
        if srs_el is None or origin_el is None or not srs_el.text or not origin_el.text:
            continue
        try:
            ox, oy, oz = (float(v) for v in origin_el.text.strip().split(","))
        except ValueError:
            log.warning("Malformed <SRSOrigin> in %s: %r", xml_file, origin_el.text)
            continue
        crs = srs_el.text.strip()
        log.info("Found geo-reference in %s: crs=%s origin=(%s, %s, %s)", xml_file.name, crs, ox, oy, oz)
        return _GeoOrigin(crs=crs, x=ox, y=oy, z=oz)
    return None


class ObjReader:
    """Handles Wavefront OBJ 3D model inputs — a bare `.obj`, or a zip
    bundle containing the `.obj` plus its `.mtl` and texture images
    (routed here by `ingestion._pick_zip_reader` peeking the zip contents)."""

    def can_handle(self, filename: str) -> bool:
        return Path(filename).suffix.lower() in _OBJ_SUFFIXES

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:
        if file_path.suffix.lower() == ".zip":
            return await self._read_zip(file_path, dataset_id)
        parsed = await asyncio.to_thread(self._parse_sync, file_path)
        if not parsed.vertices:
            return ReaderResult(inserted=0, skipped=parsed.skipped, source_crs=None, notes="No valid vertices found")
        return await self._persist(parsed, dataset_id=dataset_id)

    async def _read_zip(self, zip_path: Path, dataset_id: str) -> ReaderResult:
        import tempfile
        import zipfile

        with tempfile.TemporaryDirectory(prefix="obj_bundle_") as tmpdir:
            tmp = Path(tmpdir)
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(tmp)

            obj_files = list(tmp.rglob("*.obj"))
            if not obj_files:
                return ReaderResult(inserted=0, skipped=0, source_crs=None, notes="Zip contained no .obj file")
            obj_file = obj_files[0]
            mtl_files = list(tmp.rglob("*.mtl"))
            texture_files = [
                p for p in tmp.rglob("*")
                if p.is_file() and p.suffix.lower() in _TEXTURE_SUFFIXES
            ]
            geo_origin = _find_geo_origin(tmp)

            parsed = await asyncio.to_thread(self._parse_sync, obj_file)
            if not parsed.vertices:
                return ReaderResult(inserted=0, skipped=parsed.skipped, source_crs=None, notes="No valid vertices found")

            model_assets = await self._upload_model_assets(dataset_id, obj_file, mtl_files, texture_files)
            result = await self._persist(parsed, dataset_id=dataset_id, geo_origin=geo_origin)
            return ReaderResult(
                inserted=result.inserted,
                skipped=result.skipped,
                source_crs=result.source_crs,
                notes=result.notes,
                model_assets=model_assets,
            )

    async def _upload_model_assets(
        self,
        dataset_id: str,
        obj_file: Path,
        mtl_files: list[Path],
        texture_files: list[Path],
    ) -> dict[str, Any]:
        from app.services.storage import upload_stream

        assets: dict[str, Any] = {"textures": {}}

        with open(obj_file, "rb") as f:
            key = f"datasets/{dataset_id}/model/{obj_file.name}"
            await upload_stream(f, key=key, content_type="text/plain")
        assets["obj_key"] = key
        assets["obj_filename"] = obj_file.name

        if mtl_files:
            mtl_file = mtl_files[0]
            with open(mtl_file, "rb") as f:
                key = f"datasets/{dataset_id}/model/{mtl_file.name}"
                await upload_stream(f, key=key, content_type="text/plain")
            assets["mtl_key"] = key
            assets["mtl_filename"] = mtl_file.name

        for tex_file in texture_files:
            with open(tex_file, "rb") as f:
                key = f"datasets/{dataset_id}/model/{tex_file.name}"
                await upload_stream(f, key=key)
            assets["textures"][tex_file.name] = key

        return assets

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
            vertices=_sample_vertices(vertices, _MAX_VERTICES),
            groups=groups,
            materials=materials,
            vertex_count=vertex_count,
            face_count=face_count,
            filename=file_path.name,
            skipped=skipped,
            bbox=bbox,
        )

    async def _persist(
        self, parsed: _ParsedObj, *, dataset_id: str, geo_origin: _GeoOrigin | None = None
    ) -> ReaderResult:
        dataset_uuid = uuid.UUID(dataset_id)
        inserted = 0
        skipped = parsed.skipped
        bbox = parsed.bbox
        center_x = (bbox["min_x"] + bbox["max_x"]) / 2
        center_y = (bbox["min_y"] + bbox["max_y"]) / 2
        center_z = (bbox["min_z"] + bbox["max_z"]) / 2

        # Three ways a vertex's real-world position can be known, in order
        # of trust:
        #  1. A metadata.xml anchor was found — reproject (origin + local
        #     offset) through pyproj. This is the only way a tiled/local
        #     mesh export (the normal case for the drone survey pipeline)
        #     ever lands in its true location instead of a guess.
        #  2. The raw vertices already look like lon/lat (rare for OBJ,
        #     but some exporters do write geographic coordinates directly).
        #  3. Neither — there's no real position data at all. Spread the
        #     model around a fixed Davangere reference point so it at
        #     least renders somewhere on the map, and say so plainly
        #     rather than implying it's a real survey location.
        transformer: Transformer | None = None
        if geo_origin is not None:
            try:
                transformer = Transformer.from_crs(geo_origin.crs, "EPSG:4326", always_xy=True)
            except Exception as exc:  # noqa: BLE001 — bad/unsupported CRS string in the xml
                log.warning("Could not build a transformer for SRS %r from metadata.xml: %s", geo_origin.crs, exc)
                transformer = None

        sample = parsed.vertices[:10]
        use_geo_coords = transformer is None and (
            all(-180 <= x <= 180 for x, _, _ in sample) and
            all(-90 <= y <= 90 for _, y, _ in sample)
        )
        if transformer is not None:
            position_source = "metadata_xml"
        elif use_geo_coords:
            position_source = "geographic"
        else:
            position_source = "synthetic"
        log.info("OBJ %s: position source = %s", parsed.filename, position_source)

        batch: list[Feature] = []
        async with SessionLocal() as session:
            for idx, (x, y, z) in enumerate(parsed.vertices):
                if transformer is not None:
                    lon, lat = transformer.transform(geo_origin.x + x, geo_origin.y + y)  # type: ignore[union-attr]
                elif use_geo_coords:
                    lon, lat = x, y
                else:
                    # No real position data anywhere — this is a fallback
                    # guess, not a survey location. Kept as a fixed
                    # Davangere reference point (not this specific model's
                    # true coordinates, which are unknown) purely so
                    # something renders on the map instead of nothing.
                    dav_lat, dav_lon = 14.4644, 75.9932
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
                    "is_geo_referenced": position_source != "synthetic",
                    "position_source": position_source,
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
        source_crs = {
            "metadata_xml": geo_origin.crs if geo_origin is not None else "EPSG:4326",
            "geographic": "EPSG:4326",
            "synthetic": "LOCAL",
        }[position_source]
        return ReaderResult(
            inserted=inserted,
            skipped=skipped,
            source_crs=source_crs,
            notes=f"vertices={parsed.vertex_count}, faces={parsed.face_count}, groups={len(parsed.groups)}, position={position_source}",
        )

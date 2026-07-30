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
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from geoalchemy2.shape import from_shape
from pyproj import CRS, Transformer
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
    material_libraries: dict[str, list[str]] = field(default_factory=dict)
    texture_count: int = 0
    georef: _GeoOrigin | None = None


_MTL_SUFFIXES = {".mtl"}
_TEXTURE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif"}


@dataclass(slots=True, frozen=True)
class _GeoOrigin:
    """Real-world anchor declared by a ContextCapture/Bentley metadata file."""

    crs: str
    x: float
    y: float
    z: float

    @property
    def source_crs(self) -> str:
        return self.crs

    @property
    def origin(self) -> tuple[float, float, float]:
        return (self.x, self.y, self.z)


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


def _parse_geo_origin_xml(payload: bytes, source: str) -> _GeoOrigin | None:
    try:
        tree_root = ET.fromstring(payload)
    except ET.ParseError:
        return None
    srs_el = tree_root.find(".//SRS")
    origin_el = tree_root.find(".//SRSOrigin")
    if srs_el is None or origin_el is None or not srs_el.text or not origin_el.text:
        return None
    try:
        ox, oy, oz = (float(value) for value in origin_el.text.strip().split(","))
    except ValueError:
        log.warning("Malformed <SRSOrigin> in %s: %r", source, origin_el.text)
        return None
    return _GeoOrigin(crs=srs_el.text.strip(), x=ox, y=oy, z=oz)


def _single_geo_origin(origins: list[tuple[str, _GeoOrigin]]) -> _GeoOrigin | None:
    if not origins:
        return None
    first_source, first = origins[0]
    for source, candidate in origins[1:]:
        if candidate != first:
            raise ValueError(
                "Archive contains conflicting CRS/origin metadata: "
                f"{first_source}={first.source_crs}/{first.origin}, "
                f"{source}={candidate.source_crs}/{candidate.origin}"
            )
    return first


def _find_geo_origin(root: Path) -> _GeoOrigin | None:
    """Return one consistent metadata.xml anchor from an extracted bundle."""
    origins: list[tuple[str, _GeoOrigin]] = []
    for xml_file in root.rglob("*.xml"):
        try:
            origin = _parse_geo_origin_xml(xml_file.read_bytes(), str(xml_file))
        except OSError:
            continue
        if origin is not None:
            origins.append((str(xml_file), origin))
    consistent = _single_geo_origin(origins)
    if consistent is not None:
        log.info(
            "Found geo-reference: crs=%s origin=(%s, %s, %s)",
            consistent.crs, consistent.x, consistent.y, consistent.z,
        )
        return consistent
    return _find_prj_origin(root)


def _find_prj_origin(root: Path) -> _GeoOrigin | None:
    """Fallback for bundles that ship a plain `.prj` (CRS only, no anchor)
    instead of a ContextCapture `metadata.xml` — vertices are then assumed
    to already be absolute coordinates in that CRS, i.e. an origin of 0."""
    for prj_file in root.rglob("*.prj"):
        try:
            raw = prj_file.read_bytes().decode("utf-8-sig").strip()
        except UnicodeDecodeError:
            raw = prj_file.read_bytes().decode("latin-1").strip()
        if not raw:
            continue
        try:
            crs = CRS.from_user_input(raw)
        except Exception as exc:  # noqa: BLE001 — malformed/unsupported .prj content
            log.warning("Could not parse .prj %s: %s", prj_file, exc)
            continue
        authority = crs.to_authority()
        crs_string = f"{authority[0]}:{authority[1]}" if authority else crs.to_wkt()
        log.info("Found CRS-only geo-reference in %s: crs=%s", prj_file.name, crs_string)
        return _GeoOrigin(crs=crs_string, x=0.0, y=0.0, z=0.0)
    return None


class ObjReader:
    """Handles Wavefront OBJ 3D model inputs — standalone or ZIP bundles."""

    @staticmethod
    def _safe_asset_path(raw_path: str) -> str | None:
        """Return a normalized archive-relative path, rejecting traversal."""
        normalized = raw_path.replace("\\", "/").strip()
        if not normalized or normalized.startswith("/"):
            return None
        path = PurePosixPath(normalized)
        if any(part in {"", ".", ".."} for part in path.parts):
            return None
        if path.parts and ":" in path.parts[0]:
            return None
        return path.as_posix()

    @staticmethod
    def _resolve_asset_reference(obj_path: str, reference: str) -> str | None:
        safe_obj = ObjReader._safe_asset_path(obj_path)
        safe_reference = ObjReader._safe_asset_path(reference)
        if safe_obj is None or safe_reference is None:
            return None
        combined = PurePosixPath(safe_obj).parent / PurePosixPath(safe_reference)
        return ObjReader._safe_asset_path(combined.as_posix())

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

        parsed = await asyncio.to_thread(self._parse_sync, zip_path)
        if not parsed.vertices:
            return ReaderResult(
                inserted=0,
                skipped=parsed.skipped,
                source_crs=None,
                notes="Zip contained no valid OBJ vertices",
            )

        with tempfile.TemporaryDirectory(prefix="obj_bundle_") as tmpdir:
            tmp = Path(tmpdir)
            with zipfile.ZipFile(zip_path) as archive:
                for info in archive.infolist():
                    safe_name = self._safe_asset_path(info.filename)
                    if safe_name is None or info.is_dir():
                        continue
                    target = tmp / safe_name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(info))

            obj_files = sorted(tmp.rglob("*.obj"))
            if not obj_files:
                return ReaderResult(inserted=0, skipped=0, source_crs=None, notes="Zip contained no .obj file")
            mtl_files = sorted(tmp.rglob("*.mtl"))
            texture_files = sorted(
                path for path in tmp.rglob("*")
                if path.is_file() and path.suffix.lower() in _TEXTURE_SUFFIXES
            )

            # The current viewer accepts one primary OBJ/MTL entry. Parsing and
            # persistence still cover every OBJ in the bundle, while the first
            # model remains the viewer entry point for backward compatibility.
            model_assets = await self._upload_model_assets(
                dataset_id, obj_files[0], mtl_files, texture_files
            )
            result = await self._persist(parsed, dataset_id=dataset_id, geo_origin=parsed.georef)

            dataset_metadata = dict(result.dataset_metadata or {})
            model_3d = dict(dataset_metadata.get("model_3d") or {})
            asset_keys = {model_assets["obj_filename"]: model_assets["obj_key"]}
            if model_assets.get("mtl_filename"):
                asset_keys[model_assets["mtl_filename"]] = model_assets["mtl_key"]
            asset_keys.update(model_assets.get("textures") or {})
            model_3d["asset_keys"] = asset_keys
            model_3d["bundle_obj_count"] = len(obj_files)
            dataset_metadata["model_3d"] = model_3d

            return ReaderResult(
                inserted=result.inserted,
                skipped=result.skipped,
                source_crs=result.source_crs,
                notes=result.notes,
                model_assets=model_assets,
                dataset_metadata=dataset_metadata,
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

    @staticmethod
    def _parse_obj_text(text: str) -> tuple[
        list[tuple[float, float, float]], list[str], list[str], int, int, int
    ]:
        vertices: list[tuple[float, float, float]] = []
        groups: list[str] = []
        materials: list[str] = []
        vertex_count = 0
        face_count = 0
        skipped = 0

        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 1)
            if len(parts) < 2:
                continue
            prefix, data = parts
            if prefix == "v":
                try:
                    coords = data.split()[:3]
                    x, y, z = float(coords[0]), float(coords[1]), float(coords[2])
                    vertices.append((x, y, z))
                    vertex_count += 1
                except (ValueError, IndexError):
                    skipped += 1
            elif prefix == "f":
                face_count += 1
            elif prefix == "g":
                groups.append(data.strip())
            elif prefix == "mtllib":
                materials.extend(part for part in data.split() if part)

        return vertices, groups, materials, vertex_count, face_count, skipped

    @staticmethod
    def _bbox(vertices: list[tuple[float, float, float]]) -> dict[str, float]:
        if not vertices:
            return {}
        xs = [vertex[0] for vertex in vertices]
        ys = [vertex[1] for vertex in vertices]
        zs = [vertex[2] for vertex in vertices]
        return {
            "min_x": min(xs), "max_x": max(xs),
            "min_y": min(ys), "max_y": max(ys),
            "min_z": min(zs), "max_z": max(zs),
        }

    def _parse_zip_sync(self, file_path: Path) -> _ParsedObj:
        import zipfile

        vertices: list[tuple[float, float, float]] = []
        groups: list[str] = []
        materials: list[str] = []
        material_libraries: dict[str, list[str]] = {}
        vertex_count = 0
        face_count = 0
        skipped = 0
        texture_count = 0
        origins: list[tuple[str, _GeoOrigin]] = []

        with zipfile.ZipFile(file_path) as archive:
            for info in archive.infolist():
                safe_name = self._safe_asset_path(info.filename)
                if safe_name is None or info.is_dir():
                    continue
                suffix = PurePosixPath(safe_name).suffix.lower()
                if suffix in _TEXTURE_SUFFIXES:
                    texture_count += 1
                    continue
                payload = archive.read(info)
                if suffix == ".xml":
                    origin = _parse_geo_origin_xml(payload, safe_name)
                    if origin is not None:
                        origins.append((safe_name, origin))
                    continue
                if suffix != ".obj":
                    continue
                parsed = self._parse_obj_text(payload.decode("utf-8", errors="ignore"))
                obj_vertices, obj_groups, obj_materials, obj_vertex_count, obj_face_count, obj_skipped = parsed
                vertices.extend(obj_vertices)
                groups.extend(obj_groups)
                materials.extend(obj_materials)
                material_libraries[safe_name] = obj_materials
                vertex_count += obj_vertex_count
                face_count += obj_face_count
                skipped += obj_skipped

        return _ParsedObj(
            vertices=_sample_vertices(vertices, _MAX_VERTICES),
            groups=groups,
            materials=materials,
            vertex_count=vertex_count,
            face_count=face_count,
            filename=file_path.name,
            skipped=skipped,
            bbox=self._bbox(vertices),
            material_libraries=material_libraries,
            texture_count=texture_count,
            georef=_single_geo_origin(origins),
        )

    def _parse_sync(self, file_path: Path) -> _ParsedObj:
        if file_path.suffix.lower() == ".zip":
            return self._parse_zip_sync(file_path)

        text = file_path.read_text(encoding="utf-8", errors="ignore")
        parsed = self._parse_obj_text(text)
        vertices, groups, materials, vertex_count, face_count, skipped = parsed
        return _ParsedObj(
            vertices=_sample_vertices(vertices, _MAX_VERTICES),
            groups=groups,
            materials=materials,
            vertex_count=vertex_count,
            face_count=face_count,
            filename=file_path.name,
            skipped=skipped,
            bbox=self._bbox(vertices),
            material_libraries={file_path.name: materials},
        )

    def _coordinate_transform(
        self, parsed: _ParsedObj, fallback_lon: float, fallback_lat: float
    ) -> tuple[Callable[[float, float, float], tuple[float, float, float]], str, str]:
        if parsed.georef is not None:
            georef = parsed.georef
            transformer = Transformer.from_crs(georef.source_crs, "EPSG:4326", always_xy=True)

            def metadata_transform(x: float, y: float, z: float) -> tuple[float, float, float]:
                lon, lat = transformer.transform(georef.x + x, georef.y + y)
                return float(lon), float(lat), georef.z + z

            return metadata_transform, "metadata.xml", georef.source_crs

        sample = parsed.vertices[:10]
        if sample and all(-180 <= x <= 180 and -90 <= y <= 90 for x, y, _ in sample):
            return (lambda x, y, z: (x, y, z)), "geographic", "EPSG:4326"

        bbox = parsed.bbox
        center_x = (bbox.get("min_x", 0.0) + bbox.get("max_x", 0.0)) / 2
        center_y = (bbox.get("min_y", 0.0) + bbox.get("max_y", 0.0)) / 2

        def synthetic_transform(x: float, y: float, z: float) -> tuple[float, float, float]:
            scale = 0.0001
            return (
                fallback_lon + (x - center_x) * scale,
                fallback_lat + (y - center_y) * scale,
                z,
            )

        return synthetic_transform, "synthetic", "LOCAL"

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
            dataset_metadata={
                "model_3d": {
                    "source_crs": source_crs,
                    "vertex_count": parsed.vertex_count,
                    "face_count": parsed.face_count,
                    "position_source": position_source,
                    "is_geo_referenced": position_source != "synthetic",
                }
            },
        )

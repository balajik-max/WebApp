"""Streaming, geospatially-aware Wavefront OBJ ingestion.

OBJ vertices normally use model-local coordinates. Survey exports commonly
ship a ``metadata.xml`` beside the model with an EPSG code and an SRS origin.
This reader accepts either a legacy standalone OBJ or a ZIP containing one or
more OBJ blocks and their metadata/material/texture files. Georeferenced
vertices are transformed to WGS84 before they enter the shared map pipeline.

The source meshes can contain millions of vertices. Persisting every vertex
would overload PostGIS and the browser, so ingestion stores a model footprint
plus a deterministic reservoir sample while retaining full source counts and
bounds in dataset metadata.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import math
import mimetypes
import posixpath
import random
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from collections.abc import Callable
from typing import Any, TextIO
from xml.etree import ElementTree

from geoalchemy2.shape import from_shape
from pyproj import CRS, Transformer
from shapely.geometry import Point, Polygon

from app.db.session import SessionLocal
from app.models import Feature
from app.services.readers.base import ReaderResult
from app.services.storage import delete_object, upload_stream

log = logging.getLogger("davangere.readers.obj")

_OBJ_SUFFIXES = {".obj", ".zip"}
_BATCH_SIZE = 500
_MAX_SAMPLED_VERTICES = 500
_MAX_MODEL_FILES = 500
_MAX_METADATA_BYTES = 1024 * 1024
_TARGET_CRS = "EPSG:4326"
_MODEL_ASSET_SUFFIXES = {
    ".obj", ".mtl", ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff",
}


def _jsonable(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (str, int, bool, float)):
        return value
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:  # noqa: BLE001
            return str(value)
    return str(value)


@dataclass(slots=True, frozen=True)
class _GeoReference:
    source_crs: str
    origin: tuple[float, float, float] | None
    method: str


@dataclass(slots=True, frozen=True)
class _SampledVertex:
    x: float
    y: float
    z: float
    filename: str
    source_index: int


@dataclass(slots=True)
class _ParsedObj:
    vertices: list[_SampledVertex] = field(default_factory=list)
    groups: set[str] = field(default_factory=set)
    materials: set[str] = field(default_factory=set)
    material_libraries: dict[str, list[str]] = field(default_factory=dict)
    filenames: list[str] = field(default_factory=list)
    texture_count: int = 0
    vertex_count: int = 0
    face_count: int = 0
    skipped: int = 0
    bbox: dict[str, float] = field(default_factory=dict)
    georef: _GeoReference | None = None


def _normalized_crs(raw: str) -> str:
    crs = CRS.from_user_input(raw.strip())
    authority = crs.to_authority()
    return f"{authority[0]}:{authority[1]}" if authority else crs.to_string()


def _parse_origin(raw: str | None) -> tuple[float, float, float] | None:
    if raw is None or not raw.strip():
        return None
    values = [part.strip() for part in raw.replace(";", ",").split(",")]
    if len(values) not in {2, 3}:
        raise ValueError("SRSOrigin must contain X,Y or X,Y,Z")
    try:
        coords = tuple(float(value) for value in values)
    except ValueError as exc:
        raise ValueError("SRSOrigin contains a non-numeric coordinate") from exc
    if not all(math.isfinite(value) for value in coords):
        raise ValueError("SRSOrigin coordinates must be finite")
    return (coords[0], coords[1], coords[2] if len(coords) == 3 else 0.0)


def _parse_metadata_xml(payload: bytes, *, source: str) -> _GeoReference:
    if len(payload) > _MAX_METADATA_BYTES:
        raise ValueError(f"OBJ metadata file '{source}' is unexpectedly large")
    try:
        root = ElementTree.fromstring(payload)
    except ElementTree.ParseError as exc:
        raise ValueError(f"OBJ metadata file '{source}' is invalid XML") from exc

    srs_node = root.find(".//SRS")
    if srs_node is None or not (srs_node.text or "").strip():
        raise ValueError(f"OBJ metadata file '{source}' does not declare an SRS/EPSG code")
    origin_node = root.find(".//SRSOrigin")
    return _GeoReference(
        source_crs=_normalized_crs(srs_node.text or ""),
        origin=_parse_origin(origin_node.text if origin_node is not None else None),
        method="metadata.xml",
    )


def _parse_prj(payload: bytes, *, source: str) -> _GeoReference:
    try:
        raw = payload.decode("utf-8-sig").strip()
    except UnicodeDecodeError:
        raw = payload.decode("latin-1").strip()
    if not raw:
        raise ValueError(f"OBJ projection file '{source}' is empty")
    return _GeoReference(source_crs=_normalized_crs(raw), origin=None, method="prj")


def _same_georef(left: _GeoReference, right: _GeoReference) -> bool:
    return left.source_crs == right.source_crs and left.origin == right.origin


class ObjReader:
    """Handle standalone OBJ files and georeferenced OBJ ZIP bundles."""

    def can_handle(self, filename: str) -> bool:
        return Path(filename).suffix.lower() in _OBJ_SUFFIXES

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:
        parsed = await asyncio.to_thread(self._parse_sync, file_path)
        if not parsed.vertices:
            return ReaderResult(
                inserted=0,
                skipped=parsed.skipped,
                source_crs=parsed.georef.source_crs if parsed.georef else None,
                notes="No valid OBJ vertices found",
            )
        asset_manifest = await self._publish_model_assets(file_path, dataset_id, parsed)
        return await self._persist(parsed, dataset_id=dataset_id, asset_manifest=asset_manifest)

    def _parse_sync(self, file_path: Path) -> _ParsedObj:
        if file_path.suffix.lower() == ".zip":
            return self._parse_zip(file_path)

        parsed = _ParsedObj(filenames=[file_path.name])
        parsed.georef = self._find_local_georef(file_path)
        rng = random.Random(0x0B1EC7)
        with file_path.open("r", encoding="utf-8", errors="ignore") as stream:
            self._parse_stream(stream, file_path.name, parsed, rng)
        return parsed

    def _parse_zip(self, file_path: Path) -> _ParsedObj:
        parsed = _ParsedObj()
        rng = random.Random(0x0B1EC7)
        try:
            archive = zipfile.ZipFile(file_path)
        except zipfile.BadZipFile as exc:
            raise ValueError("Uploaded OBJ ZIP is invalid") from exc

        with archive:
            file_infos = [info for info in archive.infolist() if not info.is_dir()]
            obj_infos = [
                info for info in file_infos
                if PurePosixPath(info.filename.replace("\\", "/")).suffix.lower() == ".obj"
            ]
            if not obj_infos:
                raise ValueError("OBJ bundle does not contain an .obj file")
            if len(obj_infos) > _MAX_MODEL_FILES:
                raise ValueError(f"OBJ bundle contains more than {_MAX_MODEL_FILES} model files")

            parsed.texture_count = sum(
                PurePosixPath(info.filename.replace("\\", "/")).suffix.lower()
                in {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
                for info in file_infos
            )
            parsed.georef = self._find_zip_georef(archive, file_infos)

            for info in sorted(obj_infos, key=lambda item: item.filename.casefold()):
                normalized_name = info.filename.replace("\\", "/")
                parsed.filenames.append(normalized_name)
                with archive.open(info) as raw:
                    with io.TextIOWrapper(raw, encoding="utf-8", errors="ignore") as stream:
                        self._parse_stream(stream, normalized_name, parsed, rng)
        return parsed

    def _find_local_georef(self, file_path: Path) -> _GeoReference | None:
        metadata_candidates = (
            file_path.with_name("metadata.xml"),
            file_path.parent.parent / "metadata.xml",
        )
        for candidate in metadata_candidates:
            if candidate.is_file():
                return _parse_metadata_xml(candidate.read_bytes(), source=candidate.name)
        prj = file_path.with_suffix(".prj")
        if prj.is_file():
            return _parse_prj(prj.read_bytes(), source=prj.name)
        return None

    def _find_zip_georef(
        self,
        archive: zipfile.ZipFile,
        file_infos: list[zipfile.ZipInfo],
    ) -> _GeoReference | None:
        metadata_infos = [
            info for info in file_infos
            if PurePosixPath(info.filename.replace("\\", "/")).name.casefold() == "metadata.xml"
        ]
        references = [
            _parse_metadata_xml(archive.read(info), source=info.filename)
            for info in metadata_infos
        ]
        if not references:
            prj_infos = [
                info for info in file_infos
                if PurePosixPath(info.filename.replace("\\", "/")).suffix.lower() == ".prj"
            ]
            references = [_parse_prj(archive.read(info), source=info.filename) for info in prj_infos]
        if not references:
            return None
        first = references[0]
        if any(not _same_georef(first, item) for item in references[1:]):
            raise ValueError("OBJ bundle contains conflicting CRS/origin metadata")
        return first

    def _parse_stream(
        self,
        stream: TextIO,
        filename: str,
        parsed: _ParsedObj,
        rng: random.Random,
    ) -> None:
        source_vertex_index = 0
        for line in stream:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split(None, 1)
            if len(parts) < 2:
                continue
            prefix, data = parts
            if prefix == "v":
                source_vertex_index += 1
                try:
                    coords = data.split()[:3]
                    x, y, z = float(coords[0]), float(coords[1]), float(coords[2])
                    if not all(math.isfinite(value) for value in (x, y, z)):
                        raise ValueError
                except (ValueError, IndexError):
                    parsed.skipped += 1
                    continue
                parsed.vertex_count += 1
                self._extend_bbox(parsed.bbox, x, y, z)
                sampled = _SampledVertex(x, y, z, filename, source_vertex_index)
                if len(parsed.vertices) < _MAX_SAMPLED_VERTICES:
                    parsed.vertices.append(sampled)
                else:
                    replacement = rng.randrange(parsed.vertex_count)
                    if replacement < _MAX_SAMPLED_VERTICES:
                        parsed.vertices[replacement] = sampled
            elif prefix == "f":
                parsed.face_count += 1
            elif prefix in {"g", "o"} and data.strip():
                parsed.groups.add(data.strip())
            elif prefix == "mtllib" and data.strip():
                parsed.material_libraries.setdefault(filename, []).append(data.strip())
                parsed.materials.add(data.strip())
            elif prefix == "usemtl" and data.strip():
                parsed.materials.add(data.strip())

    async def _publish_model_assets(
        self,
        file_path: Path,
        dataset_id: str,
        parsed: _ParsedObj,
    ) -> dict[str, Any]:
        """Publish browser-loadable mesh assets outside the source ZIP."""
        asset_keys: dict[str, str] = {}
        uploaded_keys: list[str] = []
        try:
            if file_path.suffix.lower() == ".zip":
                with zipfile.ZipFile(file_path) as archive:
                    for info in archive.infolist():
                        if info.is_dir():
                            continue
                        asset_path = self._safe_asset_path(info.filename)
                        if asset_path is None or PurePosixPath(asset_path).suffix.lower() not in _MODEL_ASSET_SUFFIXES:
                            continue
                        storage_key = f"datasets/{dataset_id}/model-assets/{asset_path}"
                        content_type = mimetypes.guess_type(asset_path)[0] or "application/octet-stream"
                        with archive.open(info) as source:
                            await upload_stream(source, key=storage_key, content_type=content_type)
                        asset_keys[asset_path] = storage_key
                        uploaded_keys.append(storage_key)
            else:
                asset_path = file_path.name
                asset_keys[asset_path] = f"datasets/{dataset_id}/{file_path.name}"

            models: list[dict[str, Any]] = []
            available = set(asset_keys)
            for raw_obj_path in parsed.filenames:
                obj_path = self._safe_asset_path(raw_obj_path)
                if obj_path is None or obj_path not in available:
                    continue
                mtl_paths: list[str] = []
                for raw_mtl in parsed.material_libraries.get(raw_obj_path, []):
                    resolved = self._resolve_asset_reference(obj_path, raw_mtl)
                    if resolved in available and resolved not in mtl_paths:
                        mtl_paths.append(resolved)
                models.append({"obj_path": obj_path, "mtl_paths": mtl_paths})

            if not models:
                raise ValueError("OBJ model assets could not be prepared for browser rendering")
            return {
                "models": models,
                "assets": sorted(asset_keys),
                "asset_keys": asset_keys,
            }
        except Exception:
            for key in uploaded_keys:
                try:
                    await delete_object(key)
                except Exception:  # noqa: BLE001
                    log.exception("Could not clean up partially published OBJ asset %s", key)
            raise

    @staticmethod
    def _safe_asset_path(raw_path: str) -> str | None:
        normalized = posixpath.normpath(raw_path.replace("\\", "/")).lstrip("/")
        if not normalized or normalized == "." or normalized == ".." or normalized.startswith("../"):
            return None
        return normalized

    @classmethod
    def _resolve_asset_reference(cls, obj_path: str, raw_reference: str) -> str | None:
        # MTL filenames can contain spaces. OBJ's mtllib directive has no
        # reliable quoting grammar, so first treat the full remainder as the
        # path exported by the model author.
        return cls._safe_asset_path(posixpath.join(posixpath.dirname(obj_path), raw_reference.strip()))

    @staticmethod
    def _extend_bbox(bbox: dict[str, float], x: float, y: float, z: float) -> None:
        if not bbox:
            bbox.update(min_x=x, max_x=x, min_y=y, max_y=y, min_z=z, max_z=z)
            return
        bbox["min_x"] = min(bbox["min_x"], x)
        bbox["max_x"] = max(bbox["max_x"], x)
        bbox["min_y"] = min(bbox["min_y"], y)
        bbox["max_y"] = max(bbox["max_y"], y)
        bbox["min_z"] = min(bbox["min_z"], z)
        bbox["max_z"] = max(bbox["max_z"], z)

    async def _persist(
        self,
        parsed: _ParsedObj,
        *,
        dataset_id: str,
        asset_manifest: dict[str, Any],
    ) -> ReaderResult:
        dataset_uuid = uuid.UUID(dataset_id)
        bbox = parsed.bbox
        center_x = (bbox["min_x"] + bbox["max_x"]) / 2
        center_y = (bbox["min_y"] + bbox["max_y"]) / 2
        center_z = (bbox["min_z"] + bbox["max_z"]) / 2
        transform, georef_method, source_crs = self._coordinate_transform(parsed, center_x, center_y)

        transformed_corners = [
            transform(x, y, center_z)[:2]
            for x, y in (
                (bbox["min_x"], bbox["min_y"]),
                (bbox["max_x"], bbox["min_y"]),
                (bbox["max_x"], bbox["max_y"]),
                (bbox["min_x"], bbox["max_y"]),
            )
        ]
        valid_corners = [point for point in transformed_corners if self._valid_lon_lat(*point)]
        if len(valid_corners) != 4:
            raise ValueError("OBJ CRS transformation produced coordinates outside WGS84 bounds")

        footprint = Polygon([*valid_corners, valid_corners[0]])
        common_attrs = {
            "model_files": parsed.filenames,
            "total_vertices": parsed.vertex_count,
            "total_faces": parsed.face_count,
            "groups": sorted(parsed.groups)[:50],
            "materials": sorted(parsed.materials)[:50],
            "texture_count": parsed.texture_count,
            "source_crs": source_crs,
            "srs_origin": list(parsed.georef.origin) if parsed.georef and parsed.georef.origin else None,
            "georeference_method": georef_method,
            "bounding_box_local": bbox,
            "center_local": {"x": center_x, "y": center_y, "z": center_z},
            "is_geo_referenced": parsed.georef is not None or georef_method == "embedded_wgs84",
        }
        json.dumps(common_attrs)

        inserted = 0
        skipped = parsed.skipped
        batch: list[Feature] = [
            Feature(
                dataset_id=dataset_uuid,
                label="3D model footprint",
                category="3d_model",
                severity=0.0,
                attributes={**common_attrs, "record_type": "footprint"},
                geom=from_shape(footprint, srid=4326),
            )
        ]
        inserted += 1

        z_span = bbox["max_z"] - bbox["min_z"]
        async with SessionLocal() as session:
            for sample_index, vertex in enumerate(parsed.vertices):
                lon, lat, absolute_z = transform(vertex.x, vertex.y, vertex.z)
                if not self._valid_lon_lat(lon, lat):
                    skipped += 1
                    continue
                severity = 0.0 if z_span <= 0 else (vertex.z - bbox["min_z"]) / z_span
                attrs = {
                    "record_type": "sampled_vertex",
                    "obj_file": vertex.filename,
                    "source_vertex_index": vertex.source_index,
                    "sample_index": sample_index,
                    "x": _jsonable(vertex.x),
                    "y": _jsonable(vertex.y),
                    "z": _jsonable(vertex.z),
                    "absolute_z": _jsonable(absolute_z),
                    "source_crs": source_crs,
                    "is_geo_referenced": common_attrs["is_geo_referenced"],
                }
                batch.append(
                    Feature(
                        dataset_id=dataset_uuid,
                        label=f"Sampled vertex {sample_index + 1}",
                        category="3d_model",
                        severity=max(0.0, min(1.0, severity)),
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

        lons = [point[0] for point in valid_corners]
        lats = [point[1] for point in valid_corners]
        model_metadata = {
            "format": "obj",
            "source_crs": source_crs,
            "origin": list(parsed.georef.origin) if parsed.georef and parsed.georef.origin else None,
            "georeference_method": georef_method,
            "model_files": parsed.filenames,
            "vertex_count": parsed.vertex_count,
            "face_count": parsed.face_count,
            "sampled_vertex_count": inserted - 1,
            "texture_count": parsed.texture_count,
            "local_bounds": bbox,
            "wgs84_bounds": [min(lons), min(lats), max(lons), max(lats)],
            **asset_manifest,
        }
        if georef_method == "embedded_wgs84":
            model_metadata["render_anchor"] = None
        else:
            anchor_local = (
                (0.0, 0.0, 0.0)
                if parsed.georef is not None and parsed.georef.origin is not None
                else (center_x, center_y, center_z)
            )
            anchor_lon, anchor_lat, source_altitude = transform(*anchor_local)
            model_metadata["render_anchor"] = {
                "longitude": anchor_lon,
                "latitude": anchor_lat,
                # MapLibre's flat basemap has no absolute terrain elevation.
                # Offset the local mesh so its lowest vertex sits on z=0,
                # while retaining the surveyed elevation separately.
                "altitude": anchor_local[2] - bbox["min_z"],
                "source_altitude": source_altitude,
                "local": list(anchor_local),
            }
        log.info(
            "ObjReader ingested dataset_id=%s inserted=%d skipped=%d vertices=%d faces=%d crs=%s",
            dataset_id,
            inserted,
            skipped,
            parsed.vertex_count,
            parsed.face_count,
            source_crs,
        )
        return ReaderResult(
            inserted=inserted,
            skipped=skipped,
            source_crs=source_crs,
            notes=(
                f"models={len(parsed.filenames)}, vertices={parsed.vertex_count}, "
                f"faces={parsed.face_count}, map_sample={inserted - 1}"
            ),
            dataset_metadata={"model_3d": model_metadata},
        )

    def _coordinate_transform(
        self,
        parsed: _ParsedObj,
        center_x: float,
        center_y: float,
    ) -> tuple[Callable[[float, float, float], tuple[float, float, float]], str, str]:
        if parsed.georef is not None:
            origin = parsed.georef.origin or (0.0, 0.0, 0.0)
            projector = Transformer.from_crs(parsed.georef.source_crs, _TARGET_CRS, always_xy=True)

            def georeferenced(x: float, y: float, z: float) -> tuple[float, float, float]:
                absolute_x, absolute_y, absolute_z = x + origin[0], y + origin[1], z + origin[2]
                lon, lat = projector.transform(absolute_x, absolute_y)
                return float(lon), float(lat), absolute_z

            return georeferenced, parsed.georef.method, parsed.georef.source_crs

        sample = parsed.vertices[:10]
        embedded_wgs84 = bool(sample) and all(
            -180 <= vertex.x <= 180 and -90 <= vertex.y <= 90 for vertex in sample
        )
        if embedded_wgs84:
            return lambda x, y, z: (x, y, z), "embedded_wgs84", _TARGET_CRS

        # Legacy compatibility for standalone local-coordinate OBJ uploads.
        # New survey-model bundles should always include metadata.xml or PRJ.
        dav_lat, dav_lon = 14.4644, 76.9281
        scale = 0.0001
        return (
            lambda x, y, z: (
                dav_lon + (x - center_x) * scale,
                dav_lat + (y - center_y) * scale,
                z,
            ),
            "legacy_local_fallback",
            "LOCAL",
        )

    @staticmethod
    def _valid_lon_lat(lon: float, lat: float) -> bool:
        return math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90

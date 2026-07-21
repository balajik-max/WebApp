"""Helpers for identifying the real payload inside uploaded ZIP archives.

A ZIP is only a container.  The ingestion pipeline must inspect its members
before choosing a reader; otherwise DSM/DTM GeoTIFFs and ECW rasters are sent
to the vector GIS reader and fail with misleading GDAL errors.
"""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}
_VECTOR_EXTS = {".shp", ".dbf", ".shx", ".prj", ".cpg", ".gpkg", ".geojson", ".json", ".kml"}
_RASTER_EXTS = {".tif", ".tiff", ".geotiff"}
_ECW_EXTS = {".ecw"}
_OBJ_EXTS = {".obj"}


@dataclass(frozen=True, slots=True)
class ZipInspection:
    kind: str
    members: tuple[str, ...]
    raster_members: tuple[str, ...] = ()

    @property
    def source_format(self) -> str:
        return {
            "gdb": "gdb",
            "shapefile": "shapefile_zip",
            "vector": "vector_zip",
            "geotiff": "geotiff_zip",
            "ecw": "ecw_zip",
            "obj": "obj_bundle",
            "images": "image_bundle",
            "unknown": "zip",
        }.get(self.kind, "zip")


def _clean_members(names: Iterable[str]) -> tuple[str, ...]:
    cleaned: list[str] = []
    for raw in names:
        name = raw.replace("\\", "/")
        if not name or name.endswith("/"):
            continue
        parts = PurePosixPath(name).parts
        if not parts or "__MACOSX" in parts:
            continue
        cleaned.append(name)
    return tuple(cleaned)


def inspect_zip_names(names: Iterable[str]) -> ZipInspection:
    members = _clean_members(names)
    suffixes = {PurePosixPath(name).suffix.lower() for name in members}
    lower_members = tuple(name.lower() for name in members)

    if any(suffix in _OBJ_EXTS for suffix in suffixes):
        return ZipInspection("obj", members)

    if any(".gdb/" in name or name.endswith(".gdb") for name in lower_members):
        return ZipInspection("gdb", members)

    if ".shp" in suffixes:
        return ZipInspection("shapefile", members)

    geotiffs = tuple(
        name for name in members if PurePosixPath(name).suffix.lower() in _RASTER_EXTS
    )
    ecws = tuple(
        name for name in members if PurePosixPath(name).suffix.lower() in _ECW_EXTS
    )
    if geotiffs:
        return ZipInspection("geotiff", members, geotiffs)
    if ecws:
        return ZipInspection("ecw", members, ecws)

    if any(suffix in _VECTOR_EXTS for suffix in suffixes):
        return ZipInspection("vector", members)
    if any(suffix in _IMAGE_EXTS for suffix in suffixes):
        return ZipInspection("images", members)
    return ZipInspection("unknown", members)


def inspect_zip_path(path: Path) -> ZipInspection:
    try:
        with zipfile.ZipFile(path) as zf:
            return inspect_zip_names(zf.namelist())
    except zipfile.BadZipFile as exc:
        raise ValueError("Uploaded ZIP file is invalid or corrupted") from exc


def inspect_zip_bytes(payload: bytes) -> ZipInspection:
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            return inspect_zip_names(zf.namelist())
    except zipfile.BadZipFile as exc:
        raise ValueError("Uploaded ZIP file is invalid or corrupted") from exc

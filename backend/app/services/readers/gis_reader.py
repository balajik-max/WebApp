"""
GISReader — vector Shapefile (.shp / zipped .zip), GeoJSON (.geojson / .json),
GeoPackage (.gpkg), KML (.kml), and zipped Esri File Geodatabases (.gdb inside
a .zip).

Uses geopandas (pyogrio backend) for I/O, always reprojects to EPSG:4326
before insertion, and preserves every non-geometry attribute as a JSONB
document in `features.attributes`.
"""
from __future__ import annotations

import json
import logging
import math
import uuid
import zipfile
from pathlib import Path
from typing import Any

import geopandas as gpd
import pandas as pd
import pyogrio
from geoalchemy2.shape import from_shape
from shapely.geometry.base import BaseGeometry

from app.db.session import SessionLocal
from app.models import Feature
from app.services.readers.base import ReaderResult

log = logging.getLogger("davangere.readers.gis")

_VECTOR_SUFFIXES = {".shp", ".geojson", ".json", ".zip", ".gpkg", ".kml"}
_BATCH_SIZE = 500
_TARGET_CRS = "EPSG:4326"


def _jsonable(value: Any) -> Any:
    """Coerce pandas / numpy scalars into JSON-safe primitives."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value
    # numpy scalar -> Python primitive
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:  # noqa: BLE001
            return str(value)
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return str(value)


def _row_attributes(row: dict[str, Any]) -> dict[str, Any]:
    return {str(k): _jsonable(v) for k, v in row.items() if k != "geometry"}


def _find_gdb_entry(zip_path: Path) -> str | None:
    """Return the top-level '<name>.gdb' directory name inside a zip, if any.

    A zipped Esri File Geodatabase is a folder (not a single-file format
    like .shp/.gpkg), so it needs its own detection + read path rather
    than the plain `zip://` handling used for shapefiles.
    """
    with zipfile.ZipFile(zip_path) as zf:
        for entry in zf.namelist():
            parts = Path(entry).parts
            for part in parts:
                if part.lower().endswith(".gdb"):
                    return part
    return None


class GISReader:
    """Handles Shapefile / GeoJSON / GeoPackage / KML / zipped Shapefile / zipped File Geodatabase inputs."""

    def can_handle(self, filename: str) -> bool:
        return Path(filename).suffix.lower() in _VECTOR_SUFFIXES

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:
        return await self._read_sync_bridge(file_path, dataset_id)

    # ------------------------------------------------------------------
    # Implementation
    # ------------------------------------------------------------------
    async def _read_sync_bridge(self, file_path: Path, dataset_id: str) -> ReaderResult:
        import asyncio

        # geopandas I/O is CPU-bound → offload to a worker thread so we
        # never stall the FastAPI event loop.
        gdf, source_crs = await asyncio.to_thread(self._load_geodataframe, file_path)
        return await self._persist(gdf, dataset_id=dataset_id, source_crs=source_crs)

    def _load_geodataframe(self, file_path: Path) -> tuple[gpd.GeoDataFrame, str | None]:
        gdb_entry = _find_gdb_entry(file_path) if file_path.suffix.lower() == ".zip" else None

        if gdb_entry is not None:
            gdf = self._load_zipped_gdb(file_path, gdb_entry)
        elif file_path.suffix.lower() == ".zip":
            # Zipped Shapefiles → let pyogrio unpack via the /vsizip/ handler.
            # NOTE: SHAPE_RESTORE_SHX is deliberately NOT enabled here — GDAL
            # tries to write the repaired .shx back into the archive, which
            # fails because zip contents are read-only, breaking every
            # zipped shapefile (not just ones with a missing/corrupt .shx).
            gdf = gpd.read_file(f"zip://{file_path}")
        else:
            # Loose .shp uploaded directly (no zip) — safe to let GDAL
            # repair a missing/corrupt .shx in place on the local disk.
            pyogrio.set_gdal_config_options({"SHAPE_RESTORE_SHX": "YES"})
            try:
                gdf = gpd.read_file(file_path)
            finally:
                pyogrio.set_gdal_config_options({"SHAPE_RESTORE_SHX": "NO"})

        source_crs = str(gdf.crs) if gdf.crs is not None else None

        if gdf.crs is None:
            log.warning(
                "Dataset file %s has no CRS; assuming EPSG:4326 as declared source.",
                file_path.name,
            )
            gdf = gdf.set_crs(_TARGET_CRS, allow_override=True)
        elif str(gdf.crs).upper() != _TARGET_CRS:
            gdf = gdf.to_crs(_TARGET_CRS)

        return gdf, source_crs

    def _load_zipped_gdb(self, file_path: Path, gdb_entry: str) -> gpd.GeoDataFrame:
        """Read every layer out of a zipped Esri File Geodatabase.

        GDAL's OpenFileGDB driver reads a `.gdb` directory directly; inside
        a zip it needs the `/vsizip/` virtual filesystem prefix pointed at
        that inner directory rather than the auto-detected `zip://` scheme
        used for single-file formats (shapefile bundle, .gpkg, ...).
        """
        vsizip_path = f"/vsizip/{file_path}/{gdb_entry}"
        layers = pyogrio.list_layers(vsizip_path)
        if len(layers) == 0:
            raise ValueError(f"No readable layers found in geodatabase '{gdb_entry}'")

        frames: list[gpd.GeoDataFrame] = []
        for layer_name, _geom_type in layers:
            try:
                layer_gdf = gpd.read_file(vsizip_path, layer=layer_name)
            except Exception as exc:  # noqa: BLE001 — one bad layer shouldn't sink the whole dataset
                log.warning(
                    "Skipping unreadable layer %r in %s: %s", layer_name, gdb_entry, exc
                )
                continue
            if layer_gdf.empty:
                continue
            layer_gdf["gdb_layer"] = layer_name
            frames.append(layer_gdf)

        if not frames:
            raise ValueError(f"No usable features found in any layer of '{gdb_entry}'")

        crs = frames[0].crs
        combined = pd.concat(frames, ignore_index=True)
        return gpd.GeoDataFrame(combined, geometry="geometry", crs=crs)

    async def _persist(
        self,
        gdf: gpd.GeoDataFrame,
        *,
        dataset_id: str,
        source_crs: str | None,
    ) -> ReaderResult:
        dataset_uuid = uuid.UUID(dataset_id)
        inserted = 0
        skipped = 0

        # Convert dataframe rows lazily; batch inserts to keep memory flat.
        batch: list[Feature] = []

        # Detect label / category columns heuristically.
        columns_lower = {c.lower(): c for c in gdf.columns if c != "geometry"}
        label_col = next(
            (columns_lower[c] for c in ("name", "label", "title") if c in columns_lower),
            None,
        )
        category_col = next(
            (columns_lower[c] for c in ("category", "type", "class", "kind", "layer") if c in columns_lower),
            None,
        )
        severity_col = next(
            (columns_lower[c] for c in ("severity", "priority", "score") if c in columns_lower),
            None,
        )

        async with SessionLocal() as session:
            for _, row in gdf.iterrows():
                geom: BaseGeometry | None = row.get("geometry")
                if geom is None or geom.is_empty:
                    skipped += 1
                    continue

                attrs = _row_attributes(row.to_dict())
                # Round-trip through json so any exotic types raise here, not in DB.
                json.dumps(attrs)

                severity_val = 0.0
                if severity_col is not None:
                    raw = row.get(severity_col)
                    try:
                        if raw is not None and not (isinstance(raw, float) and math.isnan(raw)):
                            severity_val = max(0.0, min(1.0, float(raw)))
                    except (TypeError, ValueError):
                        severity_val = 0.0

                batch.append(
                    Feature(
                        dataset_id=dataset_uuid,
                        label=str(row.get(label_col)) if label_col is not None and row.get(label_col) is not None else None,
                        category=str(row.get(category_col)) if category_col is not None and row.get(category_col) is not None else None,
                        severity=severity_val,
                        attributes=attrs,
                        geom=from_shape(geom, srid=4326),
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
            "GISReader ingested dataset_id=%s inserted=%d skipped=%d source_crs=%s",
            dataset_id,
            inserted,
            skipped,
            source_crs,
        )
        return ReaderResult(inserted=inserted, skipped=skipped, source_crs=source_crs)

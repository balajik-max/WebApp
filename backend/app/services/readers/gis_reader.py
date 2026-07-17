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
from pyproj import CRS
from geoalchemy2.shape import from_shape
from shapely import force_2d
from shapely.geometry.base import BaseGeometry

from app.db.session import SessionLocal
from app.models import Feature
from app.services.classification import resolve_canonical_classes_bulk
from app.services.readers.base import ReaderResult
from app.services.readers.severity import infer_severity_from_attributes

log = logging.getLogger("davangere.readers.gis")

_VECTOR_SUFFIXES = {".shp", ".geojson", ".json", ".zip", ".gpkg", ".kml", ".gdb"}
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


def _clean_str(value: Any) -> str | None:
    """Stringify a raw attribute value for label/category, treating NaN
    floats and blank strings as missing instead of the literal text "nan"."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    text = str(value).strip()
    return text if text and text.lower() != "nan" else None


def _clean_category(value: Any) -> str | None:
    """Normalize harmless whitespace without changing the source wording."""
    cleaned = _clean_str(value)
    return " ".join(cleaned.split()) if cleaned else None


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
            gdf, source_crs = self._load_zipped_gdb(file_path, gdb_entry)
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

        if gdb_entry is None:
            source_crs = self._normalize_horizontal_crs(gdf.crs)

        if gdf.crs is None:
            log.warning(
                "Dataset file %s has no CRS; assuming EPSG:4326 as declared source.",
                file_path.name,
            )
            gdf = gdf.set_crs(_TARGET_CRS, allow_override=True)
        elif str(gdf.crs).upper() != _TARGET_CRS:
            gdf = gdf.to_crs(_TARGET_CRS)

        return gdf, source_crs

    @staticmethod
    def _normalize_horizontal_crs(raw_crs: Any) -> str | None:
        if raw_crs is None:
            return None
        try:
            horizontal = CRS.from_user_input(raw_crs).to_2d()
        except Exception:  # noqa: BLE001
            return str(raw_crs)
        authority = horizontal.to_authority()
        return f"{authority[0]}:{authority[1]}" if authority else horizontal.to_string()

    def _load_zipped_gdb(
        self,
        file_path: Path,
        gdb_entry: str,
    ) -> tuple[gpd.GeoDataFrame, str | None]:
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
        source_crs_values: set[str] = set()
        for layer_name, _geom_type in layers:
            try:
                # OpenFileGDB exposes its true source FID through the frame
                # index when ``fid_as_index`` is requested (for example a
                # Polygon table may legitimately start at FID 884). Preserve
                # it before concatenation resets the per-layer indices.
                layer_gdf = gpd.read_file(
                    vsizip_path,
                    layer=layer_name,
                    engine="pyogrio",
                    fid_as_index=True,
                )
            except Exception as exc:  # noqa: BLE001 — one bad layer shouldn't sink the whole dataset
                log.warning(
                    "Skipping unreadable layer %r in %s: %s", layer_name, gdb_entry, exc
                )
                continue
            if layer_gdf.empty:
                continue

            normalized_source_crs = self._normalize_horizontal_crs(layer_gdf.crs)
            if normalized_source_crs:
                source_crs_values.add(normalized_source_crs)

            # Real-world GDBs frequently mix CRS across layers — e.g. one
            # layer in a plain projected CRS and another with a vertical
            # height datum tacked on (WGS 84 / UTM zone 43N vs. WGS 84 /
            # UTM zone 43N + EGM2008 height). geopandas refuses to
            # `pd.concat` frames whose CRS objects aren't identical, so
            # every layer must be normalized to the shared target CRS
            # *before* concatenation, not after.
            if not any(str(column).casefold() == "fid" for column in layer_gdf.columns):
                layer_gdf.insert(0, "FID", layer_gdf.index.to_list())
            layer_gdf = layer_gdf.reset_index(drop=True)

            if layer_gdf.crs is None:
                layer_gdf = layer_gdf.set_crs(_TARGET_CRS, allow_override=True)
            elif str(layer_gdf.crs).upper() != _TARGET_CRS:
                try:
                    layer_gdf = layer_gdf.to_crs(_TARGET_CRS)
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "Skipping layer %r in %s: could not reproject from %s to %s: %s",
                        layer_name, gdb_entry, layer_gdf.crs, _TARGET_CRS, exc,
                    )
                    continue

            layer_gdf["gdb_layer"] = layer_name
            frames.append(layer_gdf)

        if not frames:
            raise ValueError(f"No usable features found in any layer of '{gdb_entry}'")

        combined = pd.concat(frames, ignore_index=True)
        source_crs: str | None = None
        if len(source_crs_values) == 1:
            source_crs = next(iter(source_crs_values))
        elif len(source_crs_values) > 1:
            log.warning(
                "GDB %s contains multiple horizontal source CRSs: %s. "
                "The combined display geometry remains EPSG:4326, but a single "
                "dataset-level source CRS cannot be declared safely.",
                gdb_entry,
                sorted(source_crs_values),
            )

        return (
            gpd.GeoDataFrame(combined, geometry="geometry", crs=_TARGET_CRS),
            source_crs,
        )

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

        # Label: prefer human-readable name/title columns
        label_priority = ("name", "label", "title", "feature_name", "asset_name",
                          "objectid", "object_id", "id", "fid")
        label_col = next(
            (columns_lower[c] for c in label_priority if c in columns_lower),
            None,
        )

        # Category: prefer columns describing what the feature is
        category_priority = ("category", "type", "class", "kind", "layer", "gdb_layer",
                             "asset_type", "feature_type", "infrastructure_type",
                             "work_type", "road_type", "drain_type", "utility_type",
                             "condition", "status", "category_name", "type_name")
        category_col = next(
            (columns_lower[c] for c in category_priority if c in columns_lower),
            None,
        )

        # Severity
        severity_col = next(
            (columns_lower[c] for c in ("severity", "priority", "score", "risk") if c in columns_lower),
            None,
        )

        # Fallback: if no label column found, pick the first string column
        # with the most non-null values (likely a descriptive name field).
        if label_col is None:
            best_count = 0
            for col_name in gdf.columns:
                if col_name == "geometry":
                    continue
                non_null = gdf[col_name].dropna()
                if non_null.empty:
                    continue
                # Only consider string-like columns
                sample = non_null.iloc[0]
                if isinstance(sample, str) and non_null.nunique() > best_count:
                    best_count = non_null.nunique()
                    label_col = col_name

        # Fallback: if no category column, look for columns with low cardinality
        # (few unique values relative to row count — likely categorical).
        if category_col is None and len(gdf) > 10:
            best_ratio = 1.0
            for col_name in gdf.columns:
                if col_name == "geometry" or col_name == label_col:
                    continue
                non_null = gdf[col_name].dropna()
                if non_null.empty:
                    continue
                ratio = non_null.nunique() / len(non_null)
                # Categorical columns typically have < 30% unique values
                if 0.01 < ratio < 0.3 and ratio < best_ratio:
                    best_ratio = ratio
                    category_col = col_name

        # A zipped File Geodatabase concatenates many original GDB feature
        # classes into one GeoDataFrame, but category_col above is a single
        # column name chosen heuristically for the WHOLE frame — some GDB
        # layers only carry their type in the per-row gdb_layer field, not
        # in whatever column category_col landed on. This helper is THE
        # single definition of "what category is this row" and must be used
        # everywhere a raw category is needed, so classification (below)
        # and the stored Feature.category (further down) never disagree.
        gdb_layer_col = columns_lower.get("gdb_layer")

        def _effective_category(row: pd.Series) -> str | None:
            val = _clean_str(row.get(category_col)) if category_col is not None else None
            if val is None and gdb_layer_col is not None:
                val = _clean_str(row.get(gdb_layer_col))
            return val

        # Resolve every distinct raw category string in this batch to a
        # canonical asset class ONCE (see app.services.classification) —
        # this is what keeps semantic classification cheap regardless of
        # how many feature rows share that category.
        canonical_by_category: dict[str, str] = {}
        async with SessionLocal() as classify_session:
            if category_col is not None or gdb_layer_col is not None:
                distinct_categories = {
                    _effective_category(row) for _, row in gdf.iterrows()
                }
                distinct_categories.discard(None)
                resolutions = await resolve_canonical_classes_bulk(
                    {str(c) for c in distinct_categories}, classify_session
                )
                canonical_by_category = {
                    raw: res.canonical_class for raw, res in resolutions.items()
                }

        async with SessionLocal() as session:
            for _, row in gdf.iterrows():
                geom: BaseGeometry | None = row.get("geometry")
                if geom is None or geom.is_empty:
                    skipped += 1
                    continue

                # The shared PostGIS column is 2D. Survey contours and other
                # GIS layers may carry Z coordinates; their source elevation
                # remains available in the imported attributes.
                if geom.has_z:
                    geom = force_2d(geom)

                attrs = _row_attributes(row.to_dict())
                effective_category = _effective_category(row)
                if effective_category is not None:
                    attrs["_canonical_class"] = canonical_by_category.get(effective_category)
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
                if severity_val == 0.0:
                    # No explicit numeric column (or it was blank) — fall back
                    # to scanning condition/status text fields for known
                    # problem keywords instead of leaving every row at 0.0.
                    severity_val = infer_severity_from_attributes(attrs)

                # Same value used for classification above (_effective_category),
                # re-cleaned through _clean_category for whitespace normalization
                # in the stored/displayed field — the two must never diverge.
                category_value = _clean_category(effective_category) if effective_category is not None else None

                batch.append(
                    Feature(
                        dataset_id=dataset_uuid,
                        label=_clean_str(row.get(label_col)) if label_col is not None else None,
                        category=category_value,
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

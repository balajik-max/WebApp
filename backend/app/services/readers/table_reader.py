"""
TableReader — CSV (.csv) + Excel (.xlsx / .xls).

Detects latitude / longitude columns from a canonical alias list, builds
PostGIS POINTs at SRID 4326, and dumps every remaining column into
`features.attributes`.  Rows with missing / invalid coordinates are
skipped and reported in the `ReaderResult`.
"""
from __future__ import annotations

import json
import logging
import math
import uuid
from pathlib import Path
from typing import Any

import pandas as pd
from geoalchemy2.shape import from_shape
from shapely.geometry import Point

from app.db.session import SessionLocal
from app.models import Feature
from app.services.readers.base import ReaderResult
from app.services.readers.severity import infer_severity_from_attributes

log = logging.getLogger("davangere.readers.table")

_TABULAR_SUFFIXES = {".csv", ".xlsx", ".xls", ".tsv"}
_BATCH_SIZE = 1000

# Ordered aliases — matched case-insensitively, longest-first.
_LAT_ALIASES = (
    "latitude", "lat_dd", "lat_deg", "gps_lat", "lat", "y",
)
_LON_ALIASES = (
    "longitude", "long", "lng", "lon_dd", "lon_deg", "gps_lon", "lon", "x",
)


def _detect_column(columns: list[str], aliases: tuple[str, ...]) -> str | None:
    lut = {c.lower().strip(): c for c in columns}
    for alias in aliases:
        if alias in lut:
            return lut[alias]
    # Fuzzy fallback: any header that *starts with* an alias (e.g. "lat_wgs84").
    for alias in aliases:
        for col_lower, original in lut.items():
            if col_lower.startswith(alias):
                return original
    return None


def _clean_str(value: Any) -> str | None:
    """Stringify a raw attribute value for label/category, treating NaN
    floats and blank strings as missing instead of the literal text "nan"."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    text = str(value).strip()
    return text if text and text.lower() != "nan" else None


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
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return str(value)


class TableReader:
    """Handles CSV / TSV / Excel inputs with lat/lon columns."""

    def can_handle(self, filename: str) -> bool:
        return Path(filename).suffix.lower() in _TABULAR_SUFFIXES

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:
        import asyncio

        df = await asyncio.to_thread(self._load_dataframe, file_path)
        return await self._persist(df, dataset_id=dataset_id)

    # ------------------------------------------------------------------
    def _load_dataframe(self, file_path: Path) -> pd.DataFrame:
        suffix = file_path.suffix.lower()
        if suffix == ".csv":
            return pd.read_csv(file_path)
        if suffix == ".tsv":
            return pd.read_csv(file_path, sep="\t")
        if suffix in (".xlsx", ".xls"):
            return pd.read_excel(file_path)
        raise ValueError(f"TableReader cannot open suffix {suffix}")

    async def _persist(self, df: pd.DataFrame, *, dataset_id: str) -> ReaderResult:
        columns = list(df.columns.astype(str))
        lat_col = _detect_column(columns, _LAT_ALIASES)
        lon_col = _detect_column(columns, _LON_ALIASES)

        if lat_col is None or lon_col is None:
            raise ValueError(
                "TableReader could not detect latitude/longitude columns. "
                f"Available headers: {columns}"
            )

        dataset_uuid = uuid.UUID(dataset_id)
        inserted = 0
        skipped = 0

        # Heuristic label / category / severity detection.
        columns_lower = {c.lower(): c for c in columns}
        label_col = next((columns_lower[c] for c in ("name", "label", "title") if c in columns_lower), None)
        category_col = next(
            (columns_lower[c] for c in ("category", "type", "class", "kind", "layer") if c in columns_lower),
            None,
        )
        severity_col = next(
            (columns_lower[c] for c in ("severity", "priority", "score") if c in columns_lower),
            None,
        )

        drop_cols = {lat_col, lon_col}
        batch: list[Feature] = []

        async with SessionLocal() as session:
            for _, row in df.iterrows():
                lat_raw = row.get(lat_col)
                lon_raw = row.get(lon_col)
                try:
                    lat = float(lat_raw)
                    lon = float(lon_raw)
                except (TypeError, ValueError):
                    skipped += 1
                    continue
                if math.isnan(lat) or math.isnan(lon):
                    skipped += 1
                    continue
                if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                    skipped += 1
                    continue

                attrs = {
                    str(col): _jsonable(row[col])
                    for col in df.columns
                    if col not in drop_cols
                }
                json.dumps(attrs)  # fail fast on non-serializable content

                severity_val = 0.0
                if severity_col is not None:
                    raw = row.get(severity_col)
                    try:
                        if raw is not None and not (isinstance(raw, float) and math.isnan(raw)):
                            severity_val = max(0.0, min(1.0, float(raw)))
                    except (TypeError, ValueError):
                        severity_val = 0.0
                if severity_val == 0.0:
                    severity_val = infer_severity_from_attributes(attrs)

                batch.append(
                    Feature(
                        dataset_id=dataset_uuid,
                        label=_clean_str(row.get(label_col)) if label_col is not None else None,
                        category=_clean_str(row.get(category_col)) if category_col is not None else None,
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
            "TableReader ingested dataset_id=%s inserted=%d skipped=%d lat=%s lon=%s",
            dataset_id,
            inserted,
            skipped,
            lat_col,
            lon_col,
        )
        return ReaderResult(
            inserted=inserted,
            skipped=skipped,
            source_crs="EPSG:4326",
            notes=f"lat_col={lat_col}, lon_col={lon_col}",
        )

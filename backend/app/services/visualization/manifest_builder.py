"""Build a dataset-specific visualization manifest from persisted PostGIS data.

This module is deliberately read-only. It does not alter ingestion, feature
storage, analytics, MapLibre layers, OBJ handling, raster handling, or any
existing API response.
"""
from __future__ import annotations

import re
import uuid
from collections import defaultdict
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Dataset
from app.schemas.visualization import (
    VisualizationFieldProfile,
    VisualizationLayerManifest,
    VisualizationManifest,
)


_LAYER_KEY_SQL = """
COALESCE(
    NULLIF(BTRIM(f.attributes ->> 'gdb_layer'), ''),
    NULLIF(BTRIM(f.category), ''),
    'uncategorized'
)
"""

_NON_EMPTY_JSONB_SQL = """
field_value NOT IN (
    'null'::jsonb,
    '""'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb
)
"""

_LAYER_SUMMARY_SQL = text(
    f"""
    WITH base AS (
        SELECT
            {_LAYER_KEY_SQL} AS layer_key,
            f.geom,
            (
                NULLIF(BTRIM(f.attributes ->> 'gdb_layer'), '') IS NOT NULL
            ) AS has_gdb_layer
        FROM features f
        WHERE f.dataset_id = :dataset_id
    )
    SELECT
        layer_key,
        COUNT(*)::bigint AS feature_count,
        ARRAY_AGG(DISTINCT GeometryType(geom)) AS geometry_types,
        BOOL_OR(has_gdb_layer) AS has_gdb_layer,
        ST_XMin(ST_Extent(geom)) AS min_lon,
        ST_YMin(ST_Extent(geom)) AS min_lat,
        ST_XMax(ST_Extent(geom)) AS max_lon,
        ST_YMax(ST_Extent(geom)) AS max_lat
    FROM base
    GROUP BY layer_key
    ORDER BY COUNT(*) DESC, layer_key ASC
    """
)

_FIELD_PROFILE_SQL = text(
    f"""
    WITH base AS (
        SELECT
            {_LAYER_KEY_SQL} AS layer_key,
            COALESCE(f.attributes, '{{}}'::jsonb) AS attributes
        FROM features f
        WHERE f.dataset_id = :dataset_id
    ),
    layer_counts AS (
        SELECT layer_key, COUNT(*)::bigint AS feature_count
        FROM base
        GROUP BY layer_key
    ),
    field_values AS (
        SELECT
            base.layer_key,
            entry.key AS field_name,
            entry.value AS field_value
        FROM base
        CROSS JOIN LATERAL jsonb_each(base.attributes) AS entry(key, value)
        WHERE entry.key !~ '^_'
    ),
    aggregated AS (
        SELECT
            layer_key,
            field_name,
            COUNT(*) FILTER (WHERE {_NON_EMPTY_JSONB_SQL})::bigint AS populated_count,
            COUNT(DISTINCT field_value) FILTER (
                WHERE {_NON_EMPTY_JSONB_SQL}
                  AND jsonb_typeof(field_value) IN ('string', 'number', 'boolean')
            )::bigint AS unique_count,
            COUNT(*) FILTER (
                WHERE {_NON_EMPTY_JSONB_SQL}
                  AND jsonb_typeof(field_value) = 'string'
            )::bigint AS string_count,
            COUNT(*) FILTER (
                WHERE {_NON_EMPTY_JSONB_SQL}
                  AND jsonb_typeof(field_value) = 'number'
            )::bigint AS number_count,
            COUNT(*) FILTER (
                WHERE {_NON_EMPTY_JSONB_SQL}
                  AND jsonb_typeof(field_value) = 'boolean'
            )::bigint AS boolean_count,
            COUNT(*) FILTER (
                WHERE {_NON_EMPTY_JSONB_SQL}
                  AND jsonb_typeof(field_value) = 'object'
            )::bigint AS object_count,
            COUNT(*) FILTER (
                WHERE {_NON_EMPTY_JSONB_SQL}
                  AND jsonb_typeof(field_value) = 'array'
            )::bigint AS array_count
        FROM field_values
        GROUP BY layer_key, field_name
    )
    SELECT
        aggregated.*,
        layer_counts.feature_count
    FROM aggregated
    JOIN layer_counts USING (layer_key)
    ORDER BY
        aggregated.layer_key,
        aggregated.populated_count DESC,
        aggregated.field_name ASC
    """
)

_DATASET_BOUNDS_SQL = text(
    """
    SELECT
        ST_XMin(ext) AS min_lon,
        ST_YMin(ext) AS min_lat,
        ST_XMax(ext) AS max_lon,
        ST_YMax(ext) AS max_lat
    FROM (
        SELECT ST_Extent(geom) AS ext
        FROM features
        WHERE dataset_id = :dataset_id
    ) bounds
    """
)


def _clean_geometry_type(value: Any) -> str:
    text_value = str(value or "Unknown").strip()
    if text_value.upper().startswith("ST_"):
        text_value = text_value[3:]
    return text_value


def _display_name(value: str) -> str:
    cleaned = re.sub(r"[_\s]+", " ", value).strip()
    return cleaned or "Uncategorized"


def _bounds_from_row(row: Any) -> list[float] | None:
    if row is None or row["min_lon"] is None:
        return None
    return [
        float(row["min_lon"]),
        float(row["min_lat"]),
        float(row["max_lon"]),
        float(row["max_lat"]),
    ]


def _renderer_for(geometry_types: list[str]) -> str:
    normalized = {value.upper() for value in geometry_types if value}
    if normalized and normalized <= {"POINT", "MULTIPOINT"}:
        return "point"
    if normalized and normalized <= {"LINESTRING", "MULTILINESTRING"}:
        return "line"
    if normalized and normalized <= {"POLYGON", "MULTIPOLYGON"}:
        return "polygon"
    return "generic"


def _field_type(row: Any) -> str:
    populated = int(row["populated_count"] or 0)
    if populated <= 0:
        return "unknown"

    type_counts = {
        "string": int(row["string_count"] or 0),
        "number": int(row["number_count"] or 0),
        "boolean": int(row["boolean_count"] or 0),
        "object": int(row["object_count"] or 0),
        "array": int(row["array_count"] or 0),
    }
    non_zero = [name for name, count in type_counts.items() if count > 0]
    if len(non_zero) == 1 and type_counts[non_zero[0]] == populated:
        return non_zero[0]
    return "mixed"


def _recommended_modes(
    *,
    renderer: str,
    feature_count: int,
    fields: list[VisualizationFieldProfile],
) -> list[str]:
    modes = ["default"]
    if renderer == "point" and feature_count >= 1000:
        modes.append("cluster")
    if any(
        field.detected_type in {"string", "boolean"}
        and field.unique_count is not None
        and 1 < field.unique_count <= 50
        for field in fields
    ):
        modes.append("category")
    if any(field.detected_type == "number" for field in fields):
        modes.append("numeric")
    if any(field.missing_count > 0 for field in fields):
        modes.append("missing-data")
    return modes


async def build_visualization_manifest(
    dataset_id: uuid.UUID,
    db: AsyncSession,
) -> VisualizationManifest:
    dataset = (
        await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    ).scalar_one_or_none()
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    layer_rows = (
        await db.execute(_LAYER_SUMMARY_SQL, {"dataset_id": dataset_id})
    ).mappings().all()
    field_rows = (
        await db.execute(_FIELD_PROFILE_SQL, {"dataset_id": dataset_id})
    ).mappings().all()
    dataset_bounds_row = (
        await db.execute(_DATASET_BOUNDS_SQL, {"dataset_id": dataset_id})
    ).mappings().first()

    fields_by_layer: dict[str, list[VisualizationFieldProfile]] = defaultdict(list)
    for row in field_rows:
        feature_count = int(row["feature_count"] or 0)
        populated_count = int(row["populated_count"] or 0)
        field_name = str(row["field_name"])

        # The zipped-GDB reader concatenates feature classes into one frame.
        # Pandas therefore carries every unioned column into every row as a
        # null value. Those zero-coverage keys are preserved in raw feature
        # attributes, but they are not useful visualization controls for a
        # layer where no feature contains a value.
        #
        # gdb_layer is also omitted here because it is already represented by
        # source_layer_name/layer_key in the manifest. It remains preserved in
        # each feature's original attributes for technical evidence.
        if populated_count <= 0 or field_name == "gdb_layer":
            continue

        fields_by_layer[str(row["layer_key"])].append(
            VisualizationFieldProfile(
                name=field_name,
                detected_type=_field_type(row),
                populated_count=populated_count,
                missing_count=max(0, feature_count - populated_count),
                unique_count=int(row["unique_count"] or 0),
            )
        )

    layers: list[VisualizationLayerManifest] = []
    has_gdb_layers = False
    total_features = 0

    for row in layer_rows:
        layer_key = str(row["layer_key"])
        feature_count = int(row["feature_count"] or 0)
        total_features += feature_count
        has_gdb_layers = has_gdb_layers or bool(row["has_gdb_layer"])
        geometry_types = sorted(
            {
                _clean_geometry_type(value)
                for value in (row["geometry_types"] or [])
            }
        )
        renderer = _renderer_for(geometry_types)
        fields = fields_by_layer.get(layer_key, [])
        warnings: list[str] = []
        if renderer == "generic":
            warnings.append(
                "The layer contains mixed or unsupported geometry types and will use generic visualization."
            )
        if not fields:
            warnings.append("No user-facing attributes were found for this layer.")

        layers.append(
            VisualizationLayerManifest(
                layer_key=layer_key,
                source_layer_name=layer_key,
                display_name=_display_name(layer_key),
                geometry_types=geometry_types,
                feature_count=feature_count,
                bounds=_bounds_from_row(row),
                fields=fields,
                recommended_renderer=renderer,
                recommended_modes=_recommended_modes(
                    renderer=renderer,
                    feature_count=feature_count,
                    fields=fields,
                ),
                warnings=warnings,
            )
        )

    metadata = dataset.dataset_metadata or {}
    file_type = getattr(dataset.file_type, "value", str(dataset.file_type))
    source_format = "gdb" if has_gdb_layers else str(
        metadata.get("source_format") or metadata.get("format") or file_type
    )
    raw_source_crs = metadata.get("source_crs") or metadata.get("crs")
    source_crs = str(raw_source_crs) if raw_source_crs is not None else None

    manifest_warnings: list[str] = []
    if not layers:
        manifest_warnings.append("The dataset has no persisted spatial features.")
    if source_crs is None:
        manifest_warnings.append(
            "The original source CRS was not preserved in dataset metadata."
        )
    if has_gdb_layers:
        manifest_warnings.append(
            "This manifest describes persisted, non-empty GDB layers. Empty or unreadable source layers are not yet retained by the current ingestion pipeline."
        )

    return VisualizationManifest(
        dataset_id=dataset.id,
        dataset_name=dataset.name,
        source_format=source_format,
        source_crs=source_crs,
        bounds=_bounds_from_row(dataset_bounds_row),
        total_features=total_features,
        layers=layers,
        warnings=manifest_warnings,
    )
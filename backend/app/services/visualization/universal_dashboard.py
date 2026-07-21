"""Generic dashboard composer for any persisted vector dataset."""
from __future__ import annotations

import re
import uuid
from typing import Iterable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.visualization import (
    DashboardLayerSummary,
    DashboardNumericSummary,
    DashboardValueCount,
    UniversalDashboard,
    VisualizationFieldProfile,
)
from app.services.visualization.manifest_builder import build_visualization_manifest


_LAYER_KEY_SQL = """
COALESCE(
    NULLIF(BTRIM(f.attributes ->> 'gdb_layer'), ''),
    NULLIF(BTRIM(f.category), ''),
    'uncategorized'
)
"""

_ISSUE_COUNTS_SQL = text(
    f"""
    SELECT {_LAYER_KEY_SQL} AS layer_key, COUNT(*)::bigint AS issue_count
    FROM features f
    WHERE f.dataset_id = :dataset_id AND f.severity >= 0.5
    GROUP BY {_LAYER_KEY_SQL}
    """
)

_TOP_CATEGORY_SQL = text(
    f"""
    SELECT
        COALESCE(NULLIF(BTRIM(f.category), ''), 'Not recorded') AS label,
        COUNT(*)::bigint AS count
    FROM features f
    WHERE f.dataset_id = :dataset_id
      AND {_LAYER_KEY_SQL} = :layer_key
    GROUP BY COALESCE(NULLIF(BTRIM(f.category), ''), 'Not recorded')
    ORDER BY COUNT(*) DESC, label ASC
    LIMIT :limit
    """
)

_TOP_FIELD_VALUES_SQL = text(
    f"""
    WITH values AS (
        SELECT NULLIF(
            BTRIM(f.attributes ->> CAST(:field_name AS text)),
            ''
        ) AS value
        FROM features f
        WHERE f.dataset_id = :dataset_id
          AND {_LAYER_KEY_SQL} = :layer_key
    )
    SELECT COALESCE(value, 'Not recorded') AS label, COUNT(*)::bigint AS count
    FROM values
    GROUP BY COALESCE(value, 'Not recorded')
    ORDER BY COUNT(*) DESC, label ASC
    LIMIT :limit
    """
)

_NUMERIC_SUMMARY_SQL = text(
    f"""
    WITH values AS (
        SELECT REPLACE(
            NULLIF(BTRIM(f.attributes ->> CAST(:field_name AS text)), ''),
            ',',
            ''
        ) AS value
        FROM features f
        WHERE f.dataset_id = :dataset_id
          AND {_LAYER_KEY_SQL} = :layer_key
    ), numeric_values AS (
        SELECT CASE
            WHEN value ~ '^-?[0-9]+([.][0-9]+)?$' THEN value::double precision
            ELSE NULL
        END AS number_value
        FROM values
    )
    SELECT
        COUNT(number_value)::bigint AS count,
        MIN(number_value) AS minimum,
        MAX(number_value) AS maximum,
        AVG(number_value) AS average
    FROM numeric_values
    """
)

_STATUS_ALIASES = {
    "condition",
    "status",
    "asset status",
    "working status",
    "health",
    "health status",
    "condition status",
    "inspection status",
    "risk level",
    "priority",
}

_SKIP_NUMERIC_NAMES = {
    "fid",
    "objectid",
    "object id",
    "id",
    "x",
    "y",
    "x long",
    "y lat",
    "longitude",
    "latitude",
}


def _normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _status_field(fields: Iterable[VisualizationFieldProfile]) -> str | None:
    best: tuple[int, str] | None = None
    for field in fields:
        normalized = _normalize(field.name)
        if normalized in _STATUS_ALIASES or any(alias in normalized for alias in _STATUS_ALIASES):
            score = field.populated_count
            if best is None or score > best[0]:
                best = (score, field.name)
    return best[1] if best else None


def _numeric_fields(fields: Iterable[VisualizationFieldProfile]) -> list[str]:
    candidates = [
        field
        for field in fields
        if field.detected_type == "number"
        and field.populated_count > 0
        and _normalize(field.name) not in _SKIP_NUMERIC_NAMES
    ]
    candidates.sort(key=lambda field: (-field.populated_count, field.name.lower()))
    return [field.name for field in candidates[:3]]


async def _top_values(
    db: AsyncSession,
    *,
    dataset_id: uuid.UUID,
    layer_key: str,
    field_name: str | None = None,
    limit: int = 8,
) -> list[DashboardValueCount]:
    statement = _TOP_FIELD_VALUES_SQL if field_name else _TOP_CATEGORY_SQL
    params = {
        "dataset_id": dataset_id,
        "layer_key": layer_key,
        "limit": limit,
    }
    if field_name:
        params["field_name"] = field_name
    rows = (await db.execute(statement, params)).mappings().all()
    return [
        DashboardValueCount(label=str(row["label"]), count=int(row["count"] or 0))
        for row in rows
    ]


async def _numeric_summary(
    db: AsyncSession,
    *,
    dataset_id: uuid.UUID,
    layer_key: str,
    field_name: str,
) -> DashboardNumericSummary:
    row = (
        await db.execute(
            _NUMERIC_SUMMARY_SQL,
            {
                "dataset_id": dataset_id,
                "layer_key": layer_key,
                "field_name": field_name,
            },
        )
    ).mappings().first()
    return DashboardNumericSummary(
        field=field_name,
        count=int(row["count"] or 0) if row else 0,
        minimum=float(row["minimum"]) if row and row["minimum"] is not None else None,
        maximum=float(row["maximum"]) if row and row["maximum"] is not None else None,
        average=float(row["average"]) if row and row["average"] is not None else None,
    )


async def build_universal_dashboard(
    dataset_id: uuid.UUID,
    db: AsyncSession,
) -> UniversalDashboard:
    manifest = await build_visualization_manifest(dataset_id, db)
    included_layers = [layer for layer in manifest.layers if layer.included]

    issue_rows = (
        await db.execute(_ISSUE_COUNTS_SQL, {"dataset_id": dataset_id})
    ).mappings().all()
    issue_by_layer = {
        str(row["layer_key"]): int(row["issue_count"] or 0)
        for row in issue_rows
    }

    geometry_totals = {"Points": 0, "Lines": 0, "Polygons": 0, "Mixed": 0}
    type_totals: dict[str, int] = {}
    dashboard_layers: list[DashboardLayerSummary] = []
    missing_values = 0
    profiled_values = 0
    total_issue_count = 0

    for layer in included_layers:
        geometry_set = {value.upper().replace("ST_", "") for value in layer.geometry_types}
        if geometry_set and geometry_set <= {"POINT", "MULTIPOINT"}:
            geometry_totals["Points"] += layer.feature_count
        elif geometry_set and geometry_set <= {"LINESTRING", "MULTILINESTRING"}:
            geometry_totals["Lines"] += layer.feature_count
        elif geometry_set and geometry_set <= {"POLYGON", "MULTIPOLYGON"}:
            geometry_totals["Polygons"] += layer.feature_count
        else:
            geometry_totals["Mixed"] += layer.feature_count

        type_totals[layer.dashboard_type] = type_totals.get(layer.dashboard_type, 0) + layer.feature_count

        layer_missing = sum(field.missing_count for field in layer.fields)
        layer_profiled = sum(field.populated_count + field.missing_count for field in layer.fields)
        missing_values += layer_missing
        profiled_values += layer_profiled
        completeness = (
            100.0
            if layer_profiled <= 0
            else max(0.0, min(100.0, 100.0 * (layer_profiled - layer_missing) / layer_profiled))
        )

        status_field = _status_field(layer.fields)
        category_breakdown = await _top_values(
            db,
            dataset_id=dataset_id,
            layer_key=layer.layer_key,
        )
        status_breakdown = (
            await _top_values(
                db,
                dataset_id=dataset_id,
                layer_key=layer.layer_key,
                field_name=status_field,
            )
            if status_field
            else []
        )
        numeric_summaries = [
            await _numeric_summary(
                db,
                dataset_id=dataset_id,
                layer_key=layer.layer_key,
                field_name=field_name,
            )
            for field_name in _numeric_fields(layer.fields)
        ]
        issue_count = issue_by_layer.get(layer.layer_key, 0)
        total_issue_count += issue_count

        dashboard_layers.append(
            DashboardLayerSummary(
                layer_key=layer.layer_key,
                display_name=layer.display_name,
                dashboard_type=layer.dashboard_type,
                geometry_types=layer.geometry_types,
                feature_count=layer.feature_count,
                completeness_percentage=round(completeness, 2),
                issue_count=issue_count,
                category_breakdown=category_breakdown,
                status_field=status_field,
                status_breakdown=status_breakdown,
                numeric_summaries=numeric_summaries,
                fields=layer.fields,
                warnings=layer.warnings,
            )
        )

    geometry_breakdown = [
        DashboardValueCount(label=label, count=count)
        for label, count in geometry_totals.items()
        if count > 0
    ]
    dashboard_types = [
        DashboardValueCount(label=label, count=count)
        for label, count in sorted(type_totals.items(), key=lambda item: (-item[1], item[0]))
    ]

    return UniversalDashboard(
        dataset_id=manifest.dataset_id,
        dataset_name=manifest.dataset_name,
        total_features=sum(layer.feature_count for layer in included_layers),
        included_layers=len(included_layers),
        point_features=geometry_totals["Points"],
        line_features=geometry_totals["Lines"],
        polygon_features=geometry_totals["Polygons"],
        issue_count=total_issue_count,
        missing_values=missing_values,
        profiled_values=profiled_values,
        geometry_breakdown=geometry_breakdown,
        dashboard_types=dashboard_types,
        layers=dashboard_layers,
        warnings=manifest.warnings,
    )

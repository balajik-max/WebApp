"""
Estimated Wastewater Flow Direction endpoint.

  GET /api/v1/wastewater-flow/manhole-flow

Reads manhole features (category="manhole") for the requested scope,
normalizes their attributes, and returns a candidate flow-direction
GeoJSON FeatureCollection via app.services.wastewater_flow. See that
module's docstring for the full "what this does NOT claim" disclaimer —
this is an estimate derived from spatial + attribute evidence, never a
verified pipe network.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db
from app.services.attribute_table import resolve_feature_fid
from app.services.class_taxonomy import CLASS_SYNONYMS, normalize_category
from app.services.wastewater_flow import (
    DEFAULT_DEPTH_UNIT,
    MAX_LINK_DISTANCE_M,
    SupportingGeometry,
    build_flow_geojson,
    normalize_manhole,
)

router = APIRouter()

_VALID_DIRECTION_STATUSES = {"confirmed", "estimated", "flat_or_uncertain", "unknown", "conflict"}
_MAX_MANHOLES = 20000
_MAX_SUPPORTING_GEOMETRY_ROWS = 5000

# Phase 10/11: road/building geometry support is entirely optional and only
# ever drawn from the SAME dataset already selected — never external/OSM
# data. These are the raw `category` synonyms this project's own GDB
# imports actually use for those two layers (see class_taxonomy.py).
_ROAD_CATEGORY_SYNONYMS = {normalize_category(s) for s in CLASS_SYNONYMS["Road_Segment"]}
_BUILDING_CATEGORY_SYNONYMS = {normalize_category(s) for s in CLASS_SYNONYMS["Building"]}


async def _fetch_supporting_geometry(db: AsyncSession, dataset_ids: list[uuid.UUID]) -> SupportingGeometry:
    """Best-effort optional road/building geometry from the same dataset(s)
    for the Phase 10/11 corridor and building-crossing checks. Returns an
    empty SupportingGeometry (checks silently no-op) if nothing usable is
    found — never raises, never fetches external data."""
    if not dataset_ids:
        return SupportingGeometry()

    rows = (
        await db.execute(
            text(
                """
                SELECT lower(coalesce(f.category, '')) AS category, ST_AsGeoJSON(f.geom)::text AS geom_json
                FROM features f
                WHERE f.dataset_id = ANY(:dataset_ids)
                  AND lower(coalesce(f.category, '')) = ANY(:categories)
                LIMIT :limit
                """
            ),
            {
                "dataset_ids": dataset_ids,
                "categories": sorted(_ROAD_CATEGORY_SYNONYMS | _BUILDING_CATEGORY_SYNONYMS),
                "limit": _MAX_SUPPORTING_GEOMETRY_ROWS,
            },
        )
    ).mappings().all()

    road_lines: list[list[tuple[float, float]]] = []
    building_rings: list[list[tuple[float, float]]] = []

    for row in rows:
        if not row["geom_json"]:
            continue
        try:
            geometry = json.loads(row["geom_json"])
        except (TypeError, ValueError):
            continue
        is_road = row["category"] in _ROAD_CATEGORY_SYNONYMS
        is_building = row["category"] in _BUILDING_CATEGORY_SYNONYMS
        if is_road:
            road_lines.extend(_extract_lines(geometry))
        elif is_building:
            building_rings.extend(_extract_rings(geometry))

    return SupportingGeometry(road_lines=road_lines, building_rings=building_rings)


def _extract_lines(geometry: dict[str, Any]) -> list[list[tuple[float, float]]]:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "LineString" and coords:
        return [[(float(c[0]), float(c[1])) for c in coords]]
    if gtype == "MultiLineString" and coords:
        return [[(float(c[0]), float(c[1])) for c in line] for line in coords]
    return []


def _extract_rings(geometry: dict[str, Any]) -> list[list[tuple[float, float]]]:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon" and coords:
        return [[(float(c[0]), float(c[1])) for c in coords[0]]] if coords else []
    if gtype == "MultiPolygon" and coords:
        return [[(float(c[0]), float(c[1])) for c in poly[0]] for poly in coords if poly]
    return []


@router.get(
    "/manhole-flow",
    dependencies=[Depends(require_any)],
    summary="Estimated wastewater flow direction (candidate manhole-to-manhole segments)",
)
async def manhole_flow_directions(
    dataset_id: list[uuid.UUID] | None = Query(
        default=None,
        description="Restrict to one or more datasets. Repeat for multiple. Required — flow links never cross datasets by default.",
    ),
    road_name: str | None = Query(default=None, max_length=256, description="Restrict to a single road name (case-insensitive, whitespace-normalized match)."),
    direction_status: list[str] | None = Query(
        default=None,
        description="Restrict output to one or more of: confirmed, estimated, flat_or_uncertain, unknown, conflict.",
    ),
    include_unknown: bool = Query(default=True, description="Include unknown/flat segments (as lines with no arrow)."),
    max_link_distance_m: float = Query(
        default=MAX_LINK_DISTANCE_M, gt=0, le=1000,
        description="Maximum candidate-link distance in metres between same-road manholes.",
    ),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if direction_status:
        invalid = [s for s in direction_status if s not in _VALID_DIRECTION_STATUSES]
        if invalid:
            raise HTTPException(
                status_code=400,
                detail=f"direction_status values must be one of {sorted(_VALID_DIRECTION_STATUSES)}, got {invalid}",
            )

    conditions = ["COALESCE(f.category, '') ILIKE 'manhole'"]
    params: dict[str, Any] = {"limit": _MAX_MANHOLES}
    if dataset_id:
        conditions.append("f.dataset_id = ANY(:dataset_ids)")
        params["dataset_ids"] = list(dict.fromkeys(dataset_id))

    where_clause = " AND ".join(conditions)
    rows = (
        await db.execute(
            text(
                f"""
                WITH ranked_features AS (
                    SELECT
                        f.*,
                        ROW_NUMBER() OVER (
                            PARTITION BY f.dataset_id ORDER BY f.created_at, f.id
                        ) AS generated_fid
                    FROM features f
                )
                SELECT
                    f.id::text                 AS id,
                    f.dataset_id::text          AS dataset_id,
                    f.attributes                AS attributes,
                    f.generated_fid              AS generated_fid,
                    ST_AsGeoJSON(f.geom)::text  AS geom_json
                FROM ranked_features f
                WHERE {where_clause}
                LIMIT :limit
                """
            ),
            params,
        )
    ).mappings().all()

    if not rows:
        return {
            "type": "FeatureCollection",
            "features": [],
            "summary": {
                "total_manholes": 0, "candidate_connections": 0, "confirmed_segments": 0,
                "derived_segments": 0, "estimated_trend_segments": 0, "unknown_segments": 0,
                "conflict_segments": 0, "manholes_with_direct_invert": 0,
                "manholes_with_derived_invert": 0, "manholes_missing_invert": 0,
            },
            "disclaimer": (
                "Flow directions are inferred from available manhole attributes and spatial "
                "relationships. Actual underground connectivity must be verified against UGD "
                "pipe survey or as-built data."
            ),
            "message": "No manhole data was found for the selected dataset(s)." if dataset_id else
                       "Select one or more datasets to generate estimated flow directions.",
        }

    normalized = []
    for row in rows:
        geometry = json.loads(row["geom_json"]) if row["geom_json"] else None
        display_id = str(resolve_feature_fid(row["attributes"], int(row["generated_fid"])))
        record = normalize_manhole(
            manhole_id=row["id"],
            dataset_id=row["dataset_id"],
            attributes=row["attributes"] or {},
            geometry=geometry,
            default_depth_unit=DEFAULT_DEPTH_UNIT,
            display_id=display_id,
        )
        if road_name:
            from app.services.wastewater_flow import normalize_road_name
            if record.road_name_normalized != normalize_road_name(road_name):
                continue
        normalized.append(record)

    supporting_geometry = await _fetch_supporting_geometry(
        db, list(dict.fromkeys(dataset_id)) if dataset_id else []
    )

    result = build_flow_geojson(
        normalized,
        max_link_distance_m=max_link_distance_m,
        include_unknown=include_unknown,
        direction_status_filter=set(direction_status) if direction_status else None,
        supporting_geometry=supporting_geometry,
    )
    result["supporting_geometry_available"] = {
        "road_lines": len(supporting_geometry.road_lines) > 0,
        "building_polygons": len(supporting_geometry.building_rings) > 0,
    }
    return result

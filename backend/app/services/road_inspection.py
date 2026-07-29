"""Road-scoped audit report built from persisted survey geometry.

Point assets are assigned to their closest surveyed Road_Centerline. Long
drain lines instead belong to the road corridor they follow for the greatest
distance, because a single touching junction is not meaningful ownership.
"""
from __future__ import annotations

import json
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.road_compat import (
    ROAD_CENTERLINE_CATEGORY_KEYS,
    ROAD_CENTERLINE_CLASS,
    road_class_predicate,
)
from app.services.road_width import fetch_road_profile
from app.services.manhole_recommend import parse_levels


# Keep the three uses of a corridor deliberately separate. A change to visual
# drain ownership must never widen the building-evidence scope by accident.
ROAD_ASSET_CORRIDOR_M = 15.0
BUILDING_EVIDENCE_CORRIDOR_M = 15.0
SOURCE_EVIDENCE_TOLERANCE_M = 1.0
ROAD_INSPECTION_CANONICAL_CLASSES = (
    "Illumination_Asset",
    "Drainage_Asset",
    "Access_Point",
    "Pothole",
    "Standing_Water",
    "Power_Line",
    "Utility_Pole",
)
ROAD_INSPECTION_CANONICAL_CLASS_SQL = ", ".join(
    f"'{canonical_class}'" for canonical_class in ROAD_INSPECTION_CANONICAL_CLASSES
)
ROAD_INSPECTION_ASSET_KEY_BY_CLASS = {
    "Illumination_Asset": "poles",
    "Drainage_Asset": "drains",
    "Access_Point": "manholes",
    "Pothole": "potholes",
    "Standing_Water": "standing_water",
    "Power_Line": "power_lines",
    "Utility_Pole": "utility_poles",
}
ROAD_INSPECTION_BUILDING_ANOMALY_SQL = "'DRAIN_ENCROACHMENT', 'POWERLINE_PROXIMITY'"

# Ingested survey files are not consistent about field casing/spelling. These
# are the only accepted road-name fields; never infer a name from a nearby
# pole/manhole because that would be unreliable at junctions.
ROAD_NAME_FIELDS = {"roadname", "streetname", "street", "name"}


def _road_display_name(label: str | None, attributes: dict | None) -> str | None:
    for key, value in (attributes or {}).items():
        normalized = "".join(ch for ch in str(key).lower() if ch.isalnum())
        if normalized not in ROAD_NAME_FIELDS:
            continue
        text_value = str(value).strip() if value is not None else ""
        if text_value and text_value != "-":
            return text_value
    label_value = (label or "").strip()
    return label_value if label_value and label_value != "-" else None


def road_asset_counter_key(canonical_class: str | None) -> str | None:
    return ROAD_INSPECTION_ASSET_KEY_BY_CLASS.get(canonical_class or "")


def _drainage_profile(asset_rows) -> dict | None:
    """Manhole Condition + surveyed invert (Top_Level/Bottom_Level) already
    sit on each Access_Point row — no separate Drainage_Level_Point join
    needed. Ordering by position along the centerline (position_frac) turns
    those individually-surveyed RLs into a real road-wide gradient check,
    same reasoning as manhole_recommend.py's single-pair slope, just walked
    across every surveyed manhole on this road instead of one pair."""
    condition_counts: dict[str, int] = {}
    pipe_type_counts: dict[str, int] = {}
    points: list[tuple[float, float]] = []
    for row in asset_rows:
        if row["canonical_class"] != "Access_Point":
            continue
        parsed = parse_levels(row["attributes"] or {})
        if parsed.condition:
            condition_counts[parsed.condition] = condition_counts.get(parsed.condition, 0) + 1
        if parsed.pipe_type:
            pipe_type_counts[parsed.pipe_type] = pipe_type_counts.get(parsed.pipe_type, 0) + 1
        level = parsed.top_level_m if parsed.top_level_m is not None else parsed.bottom_level_m
        if level is not None and row["position_frac"] is not None:
            points.append((float(row["position_frac"]), level))

    if not condition_counts and not points:
        return None

    points.sort(key=lambda p: p[0])
    net_fall_m: float | None = None
    reversed_segments = 0
    tolerance_m = 0.05
    if len(points) >= 2:
        net_fall_m = round(points[0][1] - points[-1][1], 3)
        overall_falls = net_fall_m > 0
        for (_, a), (_, b) in zip(points, points[1:]):
            local_rise = b - a
            if overall_falls and local_rise > tolerance_m:
                reversed_segments += 1
            elif not overall_falls and -local_rise > tolerance_m:
                reversed_segments += 1

    return {
        "condition_counts": condition_counts,
        "pipe_type_counts": pipe_type_counts,
        "manholes_with_level": len(points),
        "net_fall_m": net_fall_m,
        "reversed_segments": reversed_segments,
    }


async def build_road_inspection(
    road_id: uuid.UUID, db: AsyncSession
) -> dict | None:
    """Return one road's assets and active red/yellow audit findings.

    Road-width rows use their persisted centerline ID directly. Other point
    findings use their nearest road; drainage findings use the road corridor
    containing the greatest length of their source drain.
    """
    road = (
        await db.execute(
            text(
                "SELECT id, dataset_id, label, category, attributes, "
                "ST_Length(geom::geography) AS length_m, "
                "ST_AsGeoJSON(geom)::text AS geom_json "
                "FROM features "
                "WHERE id = :road_id "
                f"  AND {road_class_predicate('features', ROAD_CENTERLINE_CLASS, 'road_centerline_categories')}"
            ),
            {
                "road_id": road_id,
                "road_centerline_categories": list(ROAD_CENTERLINE_CATEGORY_KEYS),
            },
        )
    ).mappings().one_or_none()
    if road is None:
        return None

    # Drain lines are often surveyed as one long MultiLineString. A closest
    # point can be a crossing on the wrong road, so drains are owned by the
    # corridor where they have the greatest aligned length. Point-like assets
    # retain the simpler nearest-centerline rule.
    asset_rows = (
        await db.execute(
            text(
                "WITH road AS ( "
                "  SELECT id, dataset_id, geom, "
                "         ST_Buffer(geom::geography, :asset_corridor_m, 'endcap=flat join=round')::geometry AS asset_corridor "
                "  FROM features WHERE id = :road_id "
                "), assigned_assets AS ( "
                "  SELECT f.id, f.dataset_id, f.label, f.category, f.severity, "
                "         f.attributes, f.geom, r.asset_corridor, "
                "         CASE WHEN GeometryType(ST_LineMerge(r.geom)) = 'LINESTRING' "
                "              THEN ST_LineLocatePoint(ST_LineMerge(r.geom), ST_ClosestPoint(ST_LineMerge(r.geom), f.geom)) "
                "              ELSE NULL END AS position_frac, "
                "         f.attributes->>'_canonical_class' AS canonical_class "
                "  FROM features f "
                "  JOIN road r ON r.dataset_id = f.dataset_id "
                "  CROSS JOIN LATERAL ( "
                "    SELECT c.id "
                "    FROM features c "
                "    WHERE c.dataset_id = f.dataset_id "
                f"      AND {road_class_predicate('c', ROAD_CENTERLINE_CLASS, 'road_centerline_categories')} "
                "    ORDER BY CASE WHEN f.attributes->>'_canonical_class' = 'Drainage_Asset' "
                "                  THEN ST_Length(ST_Intersection(f.geom, ST_Buffer(c.geom::geography, :asset_corridor_m, 'endcap=flat join=round')::geometry)::geography) "
                "                  ELSE 0 END DESC, "
                "             ST_Distance(f.geom::geography, c.geom::geography), c.id "
                "    LIMIT 1 "
                "  ) nearest_road "
                "  WHERE f.attributes->>'_canonical_class' IN "
                f"        ({ROAD_INSPECTION_CANONICAL_CLASS_SQL}) "
                "    AND ST_Intersects(f.geom, r.asset_corridor) "
                "    AND nearest_road.id = r.id "
                ") "
                "SELECT asset.id, asset.dataset_id, asset.label, asset.category, asset.severity, "
                "       asset.attributes, asset.canonical_class, asset.position_frac, "
                "       ST_AsGeoJSON(ST_Intersection(asset.geom, asset.asset_corridor))::text AS geom_json, "
                "       status.color::text AS audit_color "
                "FROM assigned_assets asset "
                "LEFT JOIN LATERAL ( "
                "  SELECT a.color "
                "  FROM spatial_anomalies a "
                "  WHERE a.dataset_id = asset.dataset_id "
                "    AND a.status IN ('OPEN', 'REVIEWING') "
                "    AND ( "
                "      (asset.canonical_class = 'Illumination_Asset' "
                "       AND a.anomaly_type = 'POLE_REDUNDANCY' "
                "       AND a.anomaly_metadata->>'this_feature_id' = asset.id::text) "
                "      OR (asset.canonical_class = 'Drainage_Asset' "
                "          AND a.anomaly_type = 'DRAIN_ENCROACHMENT' "
                "          AND asset.id = ANY(a.feature_ids)) "
                "      OR (asset.canonical_class = 'Access_Point' "
                "          AND a.anomaly_type = 'MANHOLE_STATUS' "
                "          AND a.anomaly_metadata->>'manhole_id' = asset.id::text) "
                "      OR (asset.canonical_class = 'Power_Line' "
                "          AND a.anomaly_type = 'POWERLINE_PROXIMITY' "
                "          AND asset.id = ANY(a.feature_ids)) "
                "      OR (asset.canonical_class = 'Pothole' "
                "          AND a.anomaly_type = 'POTHOLE_STATUS' "
                "          AND a.anomaly_metadata->>'pothole_id' = asset.id::text) "
                "      OR (asset.canonical_class = 'Standing_Water' "
                "          AND a.anomaly_type = 'STANDING_WATER_STATUS' "
                "          AND a.anomaly_metadata->>'standing_water_id' = asset.id::text) "
                "    ) "
                "  ORDER BY CASE a.status WHEN 'OPEN' THEN 0 ELSE 1 END, a.created_at DESC "
                "  LIMIT 1 "
                ") status ON true"
            ),
            {
                "road_id": road_id,
                "asset_corridor_m": ROAD_ASSET_CORRIDOR_M,
                "road_centerline_categories": list(ROAD_CENTERLINE_CATEGORY_KEYS),
            },
        )
    ).mappings().all()
    assets = {key: 0 for key in ROAD_INSPECTION_ASSET_KEY_BY_CLASS.values()}
    features: list[dict] = []
    for row in asset_rows:
        key = road_asset_counter_key(row["canonical_class"])
        if key:
            assets[key] += 1
        features.append({
            "id": row["id"],
            "dataset_id": row["dataset_id"],
            "label": row["label"],
            "category": row["category"],
            "severity": row["severity"],
            "canonical_class": row["canonical_class"],
            "attributes": row["attributes"] or {},
            "geometry": json.loads(row["geom_json"]),
            "audit_color": row["audit_color"].lower() if row["audit_color"] else None,
            "evidence_for_class": None,
        })

    # Drain and powerline findings both point at a real nearby building as
    # the visible evidence. Include those buildings in the road view so the
    # corridor can be reviewed without leaving this mode.
    building_rows = (
        await db.execute(
            text(
                "WITH road AS ( "
                "  SELECT id, dataset_id, geom, "
                "         ST_Buffer(geom::geography, :asset_corridor_m, 'endcap=flat join=round')::geometry AS asset_corridor, "
                "         ST_Buffer(geom::geography, :building_corridor_m, 'endcap=flat join=round')::geometry AS building_corridor "
                "  FROM features WHERE id = :road_id "
                "), assigned_evidence AS ( "
                "  SELECT f.id, f.geom, f.attributes->>'_canonical_class' AS canonical_class, r.asset_corridor "
                "  FROM features f JOIN road r ON r.dataset_id = f.dataset_id "
                "  CROSS JOIN LATERAL ( "
                "    SELECT c.id FROM features c "
                "    WHERE c.dataset_id = f.dataset_id "
                f"      AND {road_class_predicate('c', ROAD_CENTERLINE_CLASS, 'road_centerline_categories')} "
                "    ORDER BY CASE WHEN f.attributes->>'_canonical_class' = 'Drainage_Asset' "
                "                  THEN ST_Length(ST_Intersection(f.geom, ST_Buffer(c.geom::geography, :asset_corridor_m, 'endcap=flat join=round')::geometry)::geography) "
                "                  ELSE 0 END DESC, "
                "             ST_Distance(f.geom::geography, c.geom::geography), c.id LIMIT 1 "
                "  ) nearest_road "
                "  WHERE f.attributes->>'_canonical_class' IN ('Drainage_Asset', 'Power_Line') "
                "    AND ST_Intersects(f.geom, r.asset_corridor) "
                "    AND nearest_road.id = r.id "
                ") "
                "SELECT DISTINCT ON (building.id, a.anomaly_type) building.id, building.dataset_id, building.label, "
                "       building.category, building.severity, building.attributes, a.anomaly_type, "
                "       ST_AsGeoJSON( "
                "         ST_Multi(ST_CollectionExtract( "
                "           ST_Intersection(ST_MakeValid(building.geom), r.building_corridor), "
                "           3 "
                "         )) "
                "       )::text AS geom_json, "
                "       a.color::text AS audit_color "
                "FROM spatial_anomalies a "
                "JOIN road r ON r.dataset_id = a.dataset_id "
                "JOIN features building "
                "  ON building.id = NULLIF(a.anomaly_metadata->>'building_id', '')::uuid "
                f"WHERE a.anomaly_type IN ({ROAD_INSPECTION_BUILDING_ANOMALY_SQL}) "
                "  AND a.status IN ('OPEN', 'REVIEWING') "
                "  AND ST_Intersects(building.geom, r.building_corridor) "
                "  AND EXISTS ( "
                "    SELECT 1 FROM unnest(a.feature_ids) AS finding_feature(id) "
                "    JOIN assigned_evidence evidence ON evidence.id = finding_feature.id "
                "    WHERE ST_Intersects( "
                "      ST_MakeValid(building.geom), "
                "      ST_Buffer(ST_Intersection(evidence.geom, evidence.asset_corridor)::geography, :source_evidence_tolerance_m)::geometry "
                "    ) "
                "      AND ( "
                "        (a.anomaly_type = 'DRAIN_ENCROACHMENT' AND evidence.canonical_class = 'Drainage_Asset') "
                "        OR (a.anomaly_type = 'POWERLINE_PROXIMITY' AND evidence.canonical_class = 'Power_Line') "
                "      ) "
                "  ) "
                "  AND NOT ST_IsEmpty(ST_CollectionExtract( "
                "    ST_Intersection(ST_MakeValid(building.geom), r.building_corridor), "
                "    3 "
                "  )) "
                "ORDER BY building.id, a.anomaly_type, CASE a.color WHEN 'RED' THEN 0 ELSE 1 END, a.created_at DESC"
            ),
            {
                "road_id": road_id,
                "asset_corridor_m": ROAD_ASSET_CORRIDOR_M,
                "building_corridor_m": BUILDING_EVIDENCE_CORRIDOR_M,
                "source_evidence_tolerance_m": SOURCE_EVIDENCE_TOLERANCE_M,
                "road_centerline_categories": list(ROAD_CENTERLINE_CATEGORY_KEYS),
            },
        )
    ).mappings().all()
    for row in building_rows:
        features.append({
            "id": row["id"],
            "dataset_id": row["dataset_id"],
            "label": row["label"],
            "category": row["category"],
            "severity": row["severity"],
            "canonical_class": "Building",
            "attributes": row["attributes"] or {},
            "geometry": json.loads(row["geom_json"]),
            "audit_color": row["audit_color"].lower() if row["audit_color"] else None,
            "evidence_for_class": (
                "Drainage_Asset"
                if row["anomaly_type"] == "DRAIN_ENCROACHMENT"
                else "Power_Line"
            ),
        })

    issue_rows = (
        await db.execute(
            text(
                "WITH road AS ( "
                "  SELECT id, dataset_id, geom, "
                "         ST_Buffer(geom::geography, :asset_corridor_m, 'endcap=flat join=round')::geometry AS asset_corridor "
                "  FROM features WHERE id = :road_id "
                "), assigned_assets AS ( "
                "  SELECT f.id "
                "  FROM features f "
                "  JOIN road r ON r.dataset_id = f.dataset_id "
                "  CROSS JOIN LATERAL ( "
                "    SELECT c.id "
                "    FROM features c "
                "    WHERE c.dataset_id = f.dataset_id "
                f"      AND {road_class_predicate('c', ROAD_CENTERLINE_CLASS, 'road_centerline_categories')} "
                "    ORDER BY CASE WHEN f.attributes->>'_canonical_class' = 'Drainage_Asset' "
                "                  THEN ST_Length(ST_Intersection(f.geom, ST_Buffer(c.geom::geography, :asset_corridor_m, 'endcap=flat join=round')::geometry)::geography) "
                "                  ELSE 0 END DESC, "
                "             ST_Distance(f.geom::geography, c.geom::geography), c.id "
                "    LIMIT 1 "
                "  ) nearest_road "
                "  WHERE f.attributes->>'_canonical_class' IN "
                f"        ({ROAD_INSPECTION_CANONICAL_CLASS_SQL}) "
                "    AND ST_Intersects(f.geom, r.asset_corridor) "
                "    AND nearest_road.id = r.id "
                ") "
                "SELECT a.id, a.dataset_id, a.ward, a.anomaly_type, a.color, "
                "       a.severity_score, a.status, ST_X(a.geom) AS lon, ST_Y(a.geom) AS lat, "
                "       a.feature_ids, a.anomaly_metadata, a.explanation_text, a.created_at "
                "FROM spatial_anomalies a "
                "JOIN road r ON r.dataset_id = a.dataset_id "
                "WHERE a.status IN ('OPEN', 'REVIEWING') "
                "  AND a.color IN ('RED', 'YELLOW') "
                "  AND ST_Intersects(a.geom, r.asset_corridor) "
                "  AND ( "
                "    (a.anomaly_type = 'ROAD_WIDTH_NARROWING' "
                "      AND a.anomaly_metadata->>'centerline_feature_id' = r.id::text) "
                "    OR EXISTS ( "
                "      SELECT 1 FROM unnest(a.feature_ids) AS finding_feature(id) "
                "      JOIN assigned_assets asset ON asset.id = finding_feature.id "
                "    ) "
                "  ) "
                "ORDER BY CASE a.color WHEN 'RED' THEN 0 ELSE 1 END, "
                "         a.severity_score DESC, a.created_at DESC"
            ),
            {
                "road_id": road_id,
                "asset_corridor_m": ROAD_ASSET_CORRIDOR_M,
                "road_centerline_categories": list(ROAD_CENTERLINE_CATEGORY_KEYS),
            },
        )
    ).mappings().all()

    issues = [
        {
            "id": row["id"],
            "dataset_id": row["dataset_id"],
            "ward": row["ward"],
            # DB stores the enum's member NAME (uppercase, native_enum=False
            # default) — lowercased here to match AnomalyType/.value and the
            # frontend's lowercase union types, same contract the ORM-backed
            # /audit/anomalies endpoint already returns via row.x.value.
            "anomaly_type": row["anomaly_type"].lower(),
            "color": row["color"].lower(),
            "severity_score": row["severity_score"],
            "status": row["status"].lower(),
            "lon": row["lon"],
            "lat": row["lat"],
            "feature_ids": list(row["feature_ids"]),
            "anomaly_metadata": row["anomaly_metadata"],
            "explanation_text": row["explanation_text"],
            "created_at": row["created_at"],
        }
        for row in issue_rows
    ]

    # Pothole repair costs are already computed and cached per-anomaly
    # (surface_issue_audit.py) — a road-level total is a plain sum over what's
    # already in anomaly_metadata, never a recomputation.
    pothole_cost_total_inr = None
    pothole_costs = [
        issue["anomaly_metadata"].get("estimated_repair_cost_inr")
        for issue in issues
        if issue["anomaly_type"] == "pothole_status"
        and issue["anomaly_metadata"].get("estimated_repair_cost_inr") is not None
    ]
    if pothole_costs:
        pothole_cost_total_inr = round(sum(pothole_costs), 2)

    road_profile = await fetch_road_profile(road["dataset_id"], road_id, db)
    drainage_profile = _drainage_profile(asset_rows)

    return {
        "road_id": road["id"],
        "dataset_id": road["dataset_id"],
        "road_label": _road_display_name(road["label"], road["attributes"]),
        "road_category": road["category"],
        "road_length_m": round(float(road["length_m"]), 1),
        "road_geometry": json.loads(road["geom_json"]) if road["geom_json"] else None,
        "roadside_corridor_m": ROAD_ASSET_CORRIDOR_M,
        "assets": assets,
        "features": features,
        "issues": issues,
        "road_profile": road_profile,
        "pothole_cost_total_inr": pothole_cost_total_inr,
        "drainage_profile": drainage_profile,
    }

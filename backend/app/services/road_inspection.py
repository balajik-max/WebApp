"""Road-scoped audit report built from persisted survey geometry.

Each roadside asset is assigned to its closest surveyed Road_Centerline, then
accepted only inside a small roadside corridor. This prevents a click on one
road from pulling in assets or findings that belong to a neighbouring road.
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


ROAD_SIDE_CORRIDOR_M = 15.0

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


async def build_road_inspection(
    road_id: uuid.UUID, db: AsyncSession
) -> dict | None:
    """Return one road's assets and active red/yellow audit findings.

    Road-width rows use their persisted centerline ID directly. Every other
    finding is linked through one of its source features, which must be closer
    to this road than to any other surveyed centerline and within the corridor.
    """
    road = (
        await db.execute(
            text(
                "SELECT id, dataset_id, label, category, attributes, "
                "ST_Length(geom::geography) AS length_m "
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

    # The nearest-centerline rule gives each asset a stable road owner. The
    # distance cap avoids assigning assets that are merely somewhere nearby.
    asset_rows = (
        await db.execute(
            text(
                "WITH road AS ( "
                "  SELECT id, dataset_id, geom FROM features WHERE id = :road_id "
                "), assigned_assets AS ( "
                "  SELECT f.id, f.dataset_id, f.label, f.category, f.severity, "
                "         f.attributes, f.geom, "
                "         f.attributes->>'_canonical_class' AS canonical_class "
                "  FROM features f "
                "  JOIN road r ON r.dataset_id = f.dataset_id "
                "  CROSS JOIN LATERAL ( "
                "    SELECT c.id "
                "    FROM features c "
                "    WHERE c.dataset_id = f.dataset_id "
                f"      AND {road_class_predicate('c', ROAD_CENTERLINE_CLASS, 'road_centerline_categories')} "
                "    ORDER BY ST_Distance(f.geom::geography, c.geom::geography), c.id "
                "    LIMIT 1 "
                "  ) nearest_road "
                "  WHERE f.attributes->>'_canonical_class' IN "
                "        ('Illumination_Asset', 'Drainage_Asset', 'Access_Point') "
                "    AND ST_DWithin(f.geom::geography, r.geom::geography, :corridor_m) "
                "    AND nearest_road.id = r.id "
                ") "
                "SELECT asset.id, asset.dataset_id, asset.label, asset.category, asset.severity, "
                "       asset.attributes, asset.canonical_class, "
                "       ST_AsGeoJSON(asset.geom)::text AS geom_json, status.color::text AS audit_color "
                "FROM assigned_assets asset "
                "LEFT JOIN LATERAL ( "
                "  SELECT a.color "
                "  FROM spatial_anomalies a "
                "  WHERE a.dataset_id = asset.dataset_id "
                "    AND a.status IN ('open', 'reviewing') "
                "    AND ( "
                "      (asset.canonical_class = 'Illumination_Asset' "
                "       AND a.anomaly_type = 'pole_redundancy' "
                "       AND a.anomaly_metadata->>'this_feature_id' = asset.id::text) "
                "      OR (asset.canonical_class = 'Access_Point' "
                "          AND a.anomaly_type = 'manhole_status' "
                "          AND a.anomaly_metadata->>'manhole_id' = asset.id::text) "
                "    ) "
                "  ORDER BY CASE a.status WHEN 'open' THEN 0 ELSE 1 END, a.created_at DESC "
                "  LIMIT 1 "
                ") status ON true"
            ),
            {
                "road_id": road_id,
                "corridor_m": ROAD_SIDE_CORRIDOR_M,
                "road_centerline_categories": list(ROAD_CENTERLINE_CATEGORY_KEYS),
            },
        )
    ).mappings().all()
    assets = {"poles": 0, "drains": 0, "manholes": 0}
    features: list[dict] = []
    for row in asset_rows:
        key = {
            "Illumination_Asset": "poles",
            "Drainage_Asset": "drains",
            "Access_Point": "manholes",
        }.get(row["canonical_class"])
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
            "audit_color": row["audit_color"],
        })

    # A drain finding is about the drain and the building it crosses. Include
    # that building so the road view shows the same visible evidence as the
    # normal Drains mode, without pulling in unrelated nearby buildings.
    building_rows = (
        await db.execute(
            text(
                "WITH road AS ( "
                "  SELECT id, dataset_id, geom FROM features WHERE id = :road_id "
                "), assigned_drains AS ( "
                "  SELECT f.id "
                "  FROM features f JOIN road r ON r.dataset_id = f.dataset_id "
                "  CROSS JOIN LATERAL ( "
                "    SELECT c.id FROM features c "
                "    WHERE c.dataset_id = f.dataset_id "
                f"      AND {road_class_predicate('c', ROAD_CENTERLINE_CLASS, 'road_centerline_categories')} "
                "    ORDER BY ST_Distance(f.geom::geography, c.geom::geography), c.id LIMIT 1 "
                "  ) nearest_road "
                "  WHERE f.attributes->>'_canonical_class' = 'Drainage_Asset' "
                "    AND ST_DWithin(f.geom::geography, r.geom::geography, :corridor_m) "
                "    AND nearest_road.id = r.id "
                ") "
                "SELECT DISTINCT ON (building.id) building.id, building.dataset_id, building.label, "
                "       building.category, building.severity, building.attributes, "
                "       ST_AsGeoJSON(building.geom)::text AS geom_json, a.color::text AS audit_color "
                "FROM spatial_anomalies a "
                "JOIN road r ON r.dataset_id = a.dataset_id "
                "JOIN features building ON building.id = (a.anomaly_metadata->>'building_id')::uuid "
                "WHERE a.anomaly_type = 'drain_encroachment' "
                "  AND a.status IN ('open', 'reviewing') "
                "  AND EXISTS ( "
                "    SELECT 1 FROM unnest(a.feature_ids) AS finding_feature(id) "
                "    JOIN assigned_drains drain ON drain.id = finding_feature.id "
                "  ) "
                "ORDER BY building.id, CASE a.color WHEN 'red' THEN 0 ELSE 1 END, a.created_at DESC"
            ),
            {
                "road_id": road_id,
                "corridor_m": ROAD_SIDE_CORRIDOR_M,
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
            "audit_color": row["audit_color"],
        })

    issue_rows = (
        await db.execute(
            text(
                "WITH road AS ( "
                "  SELECT id, dataset_id, geom FROM features WHERE id = :road_id "
                "), assigned_assets AS ( "
                "  SELECT f.id "
                "  FROM features f "
                "  JOIN road r ON r.dataset_id = f.dataset_id "
                "  CROSS JOIN LATERAL ( "
                "    SELECT c.id "
                "    FROM features c "
                "    WHERE c.dataset_id = f.dataset_id "
                f"      AND {road_class_predicate('c', ROAD_CENTERLINE_CLASS, 'road_centerline_categories')} "
                "    ORDER BY ST_Distance(f.geom::geography, c.geom::geography), c.id "
                "    LIMIT 1 "
                "  ) nearest_road "
                "  WHERE f.attributes->>'_canonical_class' IN "
                "        ('Illumination_Asset', 'Drainage_Asset', 'Access_Point') "
                "    AND ST_DWithin(f.geom::geography, r.geom::geography, :corridor_m) "
                "    AND nearest_road.id = r.id "
                ") "
                "SELECT a.id, a.dataset_id, a.ward, a.anomaly_type, a.color, "
                "       a.severity_score, a.status, ST_X(a.geom) AS lon, ST_Y(a.geom) AS lat, "
                "       a.feature_ids, a.anomaly_metadata, a.explanation_text, a.created_at "
                "FROM spatial_anomalies a "
                "JOIN road r ON r.dataset_id = a.dataset_id "
                "WHERE a.status IN ('open', 'reviewing') "
                "  AND a.color IN ('red', 'yellow') "
                "  AND ( "
                "    (a.anomaly_type = 'road_width_narrowing' "
                "      AND a.anomaly_metadata->>'centerline_feature_id' = r.id::text) "
                "    OR EXISTS ( "
                "      SELECT 1 FROM unnest(a.feature_ids) AS finding_feature(id) "
                "      JOIN assigned_assets asset ON asset.id = finding_feature.id "
                "    ) "
                "  ) "
                "ORDER BY CASE a.color WHEN 'red' THEN 0 ELSE 1 END, "
                "         a.severity_score DESC, a.created_at DESC"
            ),
            {
                "road_id": road_id,
                "corridor_m": ROAD_SIDE_CORRIDOR_M,
                "road_centerline_categories": list(ROAD_CENTERLINE_CATEGORY_KEYS),
            },
        )
    ).mappings().all()

    issues = [
        {
            "id": row["id"],
            "dataset_id": row["dataset_id"],
            "ward": row["ward"],
            "anomaly_type": row["anomaly_type"],
            "color": row["color"],
            "severity_score": row["severity_score"],
            "status": row["status"],
            "lon": row["lon"],
            "lat": row["lat"],
            "feature_ids": list(row["feature_ids"]),
            "anomaly_metadata": row["anomaly_metadata"],
            "explanation_text": row["explanation_text"],
            "created_at": row["created_at"],
        }
        for row in issue_rows
    ]
    return {
        "road_id": road["id"],
        "dataset_id": road["dataset_id"],
        "road_label": _road_display_name(road["label"], road["attributes"]),
        "road_category": road["category"],
        "road_length_m": round(float(road["length_m"]), 1),
        "roadside_corridor_m": ROAD_SIDE_CORRIDOR_M,
        "assets": assets,
        "features": features,
        "issues": issues,
    }

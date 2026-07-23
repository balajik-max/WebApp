"""Deterministic pothole and standing-water audit detectors.

These detectors extend the existing spatial-audit engine without changing the
pole, drain, manhole, or road algorithms. They use only persisted survey
geometry and attributes. No measurement is invented: missing depth/volume is
stored as ``None`` and severity falls back to the evidence that is available.
"""
from __future__ import annotations

import math
import re
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.spatial_anomaly import AnomalyColor, AnomalyType, SpatialAnomaly

_AREA_ALIASES = (
    # Only aliases that explicitly state square metres are accepted. Generic
    # Shape_Area/area values may be in source-CRS units, so geometry-derived
    # geography area is the authoritative fallback.
    "Area_sqm",
    "Area_m2",
    "Area_sq_m",
    "Area_Square_Metres",
    "Area_Square_Meters",
)
_ELEVATION_ALIASES = (
    "Elevation",
    "Elevation_m",
    "RL",
    "Reduced_Level",
    "Z_Level",
    "Bottom_Elevation",
    "Bottom_RL",
)
_TOP_ELEVATION_ALIASES = (
    "Elevation",
    "Elevation_m",
    "RL",
    "Reduced_Level",
    "Z_Level",
    "Top_Elevation",
    "Top_RL",
    "Road_Level",
)
_DEPTH_ALIASES = (
    "Depth_m",
    "Average_Depth_m",
    "Avg_Depth_m",
    "Pothole_Depth_m",
    "Depth_cm",
    "Average_Depth_cm",
    "Avg_Depth_cm",
    "Pothole_Depth_cm",
    "Depth_mm",
    "Depth",
)
_VOLUME_ALIASES = (
    # Deliberately exclude a bare "Volume" field because its unit is unknown.
    "Volume_m3",
    "Volume_Cubic_M",
    "Volume_Cubic_Meter",
    "Volume_Cubic_Metre",
    "Cubic_Meter",
    "Cubic_Metre",
)


def _normalize(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower()).strip()


def _number(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    match = re.search(r"-?\d+(?:\.\d+)?", str(value).replace(",", ""))
    if not match:
        return None
    number = float(match.group(0))
    return number if math.isfinite(number) else None


def _first_number(attributes: dict[str, Any], aliases: tuple[str, ...]) -> tuple[float | None, str | None, object | None]:
    normalized = {_normalize(key): (key, value) for key, value in attributes.items()}
    for alias in aliases:
        entry = normalized.get(_normalize(alias))
        if entry is None:
            continue
        number = _number(entry[1])
        if number is not None:
            return number, entry[0], entry[1]
    return None, None, None


def _depth_metres(attributes: dict[str, Any]) -> float | None:
    value, key, raw = _first_number(attributes, _DEPTH_ALIASES)
    if value is None or key is None:
        return None
    normalized_key = _normalize(key)
    normalized_raw = str(raw or "").lower()
    if "mm" in normalized_key or re.search(r"\bmm\b", normalized_raw):
        value /= 1000.0
    elif "cm" in normalized_key or re.search(r"\bcm\b", normalized_raw):
        value /= 100.0
    elif normalized_key == "depth":
        # A bare numeric Depth has no trustworthy unit. Refuse to guess. A
        # textual value such as "0.08 m" is accepted as metres.
        if not re.search(r"(?:\d\s*m\b|\bmet(?:er|re)s?\b)", normalized_raw):
            return None
    return value if value >= 0 else None


def _positive(value: float | None) -> float | None:
    return value if value is not None and math.isfinite(value) and value >= 0 else None


def _severity_label(score: float) -> str:
    if score >= 80:
        return "Critical"
    if score >= 60:
        return "High"
    if score >= 40:
        return "Moderate"
    return "Low"


def pothole_severity(
    *,
    area_sqm: float | None,
    depth_m: float | None,
    volume_m3: float | None,
    road_distance_m: float | None,
) -> tuple[float, AnomalyColor, list[str]]:
    """Return a deterministic 0-100 score, map color, and evidence reasons."""
    area = _positive(area_sqm) or 0.0
    depth = _positive(depth_m)
    volume = _positive(volume_m3)
    score = 20.0
    reasons: list[str] = ["mapped_pothole"]

    if area > 0:
        score += min(25.0, (area / 4.0) * 25.0)
        if area >= 2.0:
            reasons.append("large_area")
    if depth is not None:
        score += min(40.0, (depth / 0.20) * 40.0)
        if depth >= 0.10:
            reasons.append("deep_pothole")
    else:
        reasons.append("depth_unavailable")
    if volume is not None:
        score += min(20.0, (volume / 0.20) * 20.0)
        if volume >= 0.10:
            reasons.append("high_repair_volume")
    if road_distance_m is not None and road_distance_m <= 3.0:
        score += 10.0
        reasons.append("on_or_near_road")

    score = round(min(100.0, score), 1)
    return score, AnomalyColor.RED if score >= 60.0 else AnomalyColor.YELLOW, reasons


def standing_water_severity(
    *,
    area_sqm: float | None,
    road_distance_m: float | None,
    road_intersects: bool,
    drain_distance_m: float | None,
    drain_intersects: bool,
) -> tuple[float, AnomalyColor, list[str]]:
    area = _positive(area_sqm) or 0.0
    score = 15.0
    reasons: list[str] = ["mapped_standing_water"]

    if area > 0:
        score += min(45.0, (area / 20.0) * 45.0)
        if area >= 15.0:
            reasons.append("large_affected_area")
    if road_intersects or (road_distance_m is not None and road_distance_m <= 1.0):
        score += 20.0
        reasons.append("on_road")
    elif road_distance_m is not None and road_distance_m <= 5.0:
        score += 10.0
        reasons.append("near_road")
    if drain_intersects or (drain_distance_m is not None and drain_distance_m <= 10.0):
        score += 5.0
        reasons.append("near_drain")

    score = round(min(100.0, score), 1)
    return score, AnomalyColor.RED if score >= 60.0 else AnomalyColor.YELLOW, reasons


async def backfill_surface_issue_classes(dataset_id: uuid.UUID, db: AsyncSession) -> None:
    """Upgrade existing ingested rows so new AI modes also work without re-upload."""
    await db.execute(
        text(
            """
            UPDATE features
            SET attributes = coalesce(attributes, '{}'::jsonb)
                || jsonb_build_object('_canonical_class', 'Pothole')
            WHERE dataset_id = :dataset_id
              AND lower(trim(coalesce(attributes->>'gdb_layer', category, '')))
                  IN ('pathhole', 'pathholes', 'pothole', 'potholes')
              AND coalesce(attributes->>'_canonical_class', '')
                  IN ('', 'Unclassified', 'Pothole')
            """
        ),
        {"dataset_id": str(dataset_id)},
    )
    await db.execute(
        text(
            """
            UPDATE features
            SET attributes = coalesce(attributes, '{}'::jsonb)
                || jsonb_build_object('_canonical_class', 'Pothole_Reference')
            WHERE dataset_id = :dataset_id
              AND lower(trim(coalesce(attributes->>'gdb_layer', category, '')))
                  IN ('pathhole_top', 'pathhole top', 'pothole_top', 'pothole top')
              AND coalesce(attributes->>'_canonical_class', '')
                  IN ('', 'Unclassified', 'Pothole_Reference')
            """
        ),
        {"dataset_id": str(dataset_id)},
    )
    await db.execute(
        text(
            """
            UPDATE features
            SET attributes = coalesce(attributes, '{}'::jsonb)
                || jsonb_build_object('_canonical_class', 'Standing_Water')
            WHERE dataset_id = :dataset_id
              AND lower(trim(coalesce(attributes->>'gdb_layer', category, '')))
                  IN ('standing_water', 'standing water', 'water_stagnation',
                      'water stagnation', 'waterlogging', 'water logging')
              AND coalesce(attributes->>'_canonical_class', '')
                  IN ('', 'Unclassified', 'Standing_Water')
            """
        ),
        {"dataset_id": str(dataset_id)},
    )


async def detect_pothole_status(
    dataset_id: uuid.UUID,
    ward: str | None,
    db: AsyncSession,
) -> dict[str, int]:
    rows = (
        await db.execute(
            text(
                """
                SELECT
                    p.id AS pothole_id,
                    p.attributes AS pothole_attributes,
                    ST_X(ST_PointOnSurface(p.geom)) AS x,
                    ST_Y(ST_PointOnSurface(p.geom)) AS y,
                    ST_Area(p.geom::geography) AS geometry_area_sqm,
                    top_feature.id AS top_feature_id,
                    top_feature.attributes AS top_attributes,
                    top_feature.distance_m AS top_distance_m,
                    road.id AS road_id,
                    road.label AS road_label,
                    road.category AS road_category,
                    road.distance_m AS road_distance_m
                FROM features p
                LEFT JOIN LATERAL (
                    SELECT
                        t.id,
                        t.attributes,
                        ST_Distance(p.geom::geography, t.geom::geography) AS distance_m
                    FROM features t
                    WHERE t.dataset_id = p.dataset_id
                      AND (
                        t.attributes->>'_canonical_class' = 'Pothole_Reference'
                        OR lower(coalesce(t.attributes->>'gdb_layer', t.category, ''))
                           IN ('pathhole_top', 'pathhole top', 'pothole_top', 'pothole top')
                      )
                      AND (
                        (
                          coalesce(t.attributes->>'FID', t.attributes->>'OBJECTID', '')
                          = coalesce(p.attributes->>'FID', p.attributes->>'OBJECTID', '')
                          AND coalesce(p.attributes->>'FID', p.attributes->>'OBJECTID', '') <> ''
                        )
                        OR ST_Intersects(p.geom, t.geom)
                      )
                    ORDER BY
                        CASE
                            WHEN coalesce(t.attributes->>'FID', t.attributes->>'OBJECTID', '')
                               = coalesce(p.attributes->>'FID', p.attributes->>'OBJECTID', '')
                               AND coalesce(p.attributes->>'FID', p.attributes->>'OBJECTID', '') <> ''
                            THEN 0
                            WHEN ST_Intersects(p.geom, t.geom) THEN 1
                            ELSE 2
                        END,
                        CASE
                            WHEN ST_Intersects(p.geom, t.geom)
                            THEN ST_Area(ST_Intersection(p.geom, t.geom)::geography)
                            ELSE 0
                        END DESC,
                        ST_Distance(p.geom::geography, t.geom::geography)
                    LIMIT 1
                ) AS top_feature ON true
                LEFT JOIN LATERAL (
                    SELECT
                        r.id,
                        r.label,
                        r.category,
                        ST_Distance(p.geom::geography, r.geom::geography) AS distance_m
                    FROM features r
                    WHERE r.dataset_id = p.dataset_id
                      AND r.attributes->>'_canonical_class'
                          IN ('Road_Centerline', 'Road_Surface', 'Road_Segment')
                      AND ST_DWithin(p.geom::geography, r.geom::geography, 50.0)
                    ORDER BY p.geom <-> r.geom
                    LIMIT 1
                ) AS road ON true
                WHERE p.dataset_id = :dataset_id
                  AND (
                    p.attributes->>'_canonical_class' = 'Pothole'
                    OR lower(coalesce(p.attributes->>'gdb_layer', p.category, ''))
                       IN ('pathhole', 'pathholes', 'pothole', 'potholes')
                  )
                """
            ),
            {"dataset_id": str(dataset_id)},
        )
    ).mappings().all()

    counts = {"red": 0, "yellow": 0, "green": 0}
    anomalies: list[SpatialAnomaly] = []
    for row in rows:
        attrs = dict(row["pothole_attributes"] or {})
        top_attrs = dict(row["top_attributes"] or {})
        geometry_area = _positive(_number(row["geometry_area_sqm"]))
        area, _, _ = _first_number(attrs, _AREA_ALIASES)
        area = _positive(area) or geometry_area

        bottom_elevation, _, _ = _first_number(attrs, _ELEVATION_ALIASES)
        top_elevation, _, _ = _first_number(top_attrs, _TOP_ELEVATION_ALIASES)
        direct_depth = _depth_metres(attrs)
        calculated_depth = None
        if top_elevation is not None and bottom_elevation is not None:
            calculated_depth = _positive(top_elevation - bottom_elevation)
        depth_m = direct_depth if direct_depth is not None else calculated_depth

        direct_volume, _, _ = _first_number(attrs, _VOLUME_ALIASES)
        direct_volume = _positive(direct_volume)
        estimated_volume = area * depth_m if area is not None and depth_m is not None else None
        volume_m3 = direct_volume if direct_volume is not None else estimated_volume

        road_distance = _positive(_number(row["road_distance_m"]))
        score, color, reasons = pothole_severity(
            area_sqm=area,
            depth_m=depth_m,
            volume_m3=volume_m3,
            road_distance_m=road_distance,
        )
        counts[color.value] += 1
        feature_ids = [row["pothole_id"]]
        anomalies.append(
            SpatialAnomaly(
                dataset_id=dataset_id,
                ward=ward,
                anomaly_type=AnomalyType.POTHOLE_STATUS,
                color=color,
                severity_score=score,
                geom=f"SRID=4326;POINT({row['x']} {row['y']})",
                feature_ids=feature_ids,
                anomaly_metadata={
                    "pothole_id": str(row["pothole_id"]),
                    "source_layer": attrs.get("gdb_layer") or attrs.get("LAYER") or "Pothole",
                    "source_fid": attrs.get("FID") or attrs.get("OBJECTID"),
                    "area_sqm": round(area, 4) if area is not None else None,
                    "bottom_elevation_m": round(bottom_elevation, 4) if bottom_elevation is not None else None,
                    "top_elevation_m": round(top_elevation, 4) if top_elevation is not None else None,
                    "depth_m": round(depth_m, 4) if depth_m is not None else None,
                    "depth_cm": round(depth_m * 100.0, 2) if depth_m is not None else None,
                    "estimated_repair_volume_m3": round(volume_m3, 4) if volume_m3 is not None else None,
                    "depth_method": "surveyed" if direct_depth is not None else "top_minus_bottom" if calculated_depth is not None else "unavailable",
                    "volume_method": "surveyed" if direct_volume is not None else "area_times_depth" if estimated_volume is not None else "unavailable",
                    "top_reference_feature_id": str(row["top_feature_id"]) if row["top_feature_id"] else None,
                    "top_reference_distance_m": round(float(row["top_distance_m"]), 2) if row["top_distance_m"] is not None else None,
                    "nearest_road_id": str(row["road_id"]) if row["road_id"] else None,
                    "nearest_road_label": row["road_label"],
                    "nearest_road_category": row["road_category"],
                    "nearest_road_distance_m": round(road_distance, 2) if road_distance is not None else None,
                    "severity_label": _severity_label(score),
                    "reasons": reasons,
                    "evidence_source": "surveyed_gdb",
                },
            )
        )

    if anomalies:
        db.add_all(anomalies)
        await db.flush()
    return counts


async def detect_standing_water_status(
    dataset_id: uuid.UUID,
    ward: str | None,
    db: AsyncSession,
) -> dict[str, int]:
    rows = (
        await db.execute(
            text(
                """
                SELECT
                    sw.id AS standing_water_id,
                    sw.attributes AS standing_water_attributes,
                    ST_X(ST_PointOnSurface(sw.geom)) AS x,
                    ST_Y(ST_PointOnSurface(sw.geom)) AS y,
                    ST_Area(sw.geom::geography) AS geometry_area_sqm,
                    road.id AS road_id,
                    road.label AS road_label,
                    road.category AS road_category,
                    road.distance_m AS road_distance_m,
                    road.intersects AS road_intersects,
                    drain.id AS drain_id,
                    drain.label AS drain_label,
                    drain.category AS drain_category,
                    drain.distance_m AS drain_distance_m,
                    drain.intersects AS drain_intersects
                FROM features sw
                LEFT JOIN LATERAL (
                    SELECT
                        r.id,
                        r.label,
                        r.category,
                        ST_Distance(sw.geom::geography, r.geom::geography) AS distance_m,
                        ST_Intersects(sw.geom, r.geom) AS intersects
                    FROM features r
                    WHERE r.dataset_id = sw.dataset_id
                      AND r.attributes->>'_canonical_class'
                          IN ('Road_Centerline', 'Road_Surface', 'Road_Segment')
                      AND ST_DWithin(sw.geom::geography, r.geom::geography, 75.0)
                    ORDER BY sw.geom <-> r.geom
                    LIMIT 1
                ) AS road ON true
                LEFT JOIN LATERAL (
                    SELECT
                        d.id,
                        d.label,
                        d.category,
                        ST_Distance(sw.geom::geography, d.geom::geography) AS distance_m,
                        ST_Intersects(sw.geom, d.geom) AS intersects
                    FROM features d
                    WHERE d.dataset_id = sw.dataset_id
                      AND d.attributes->>'_canonical_class' = 'Drainage_Asset'
                      AND ST_DWithin(sw.geom::geography, d.geom::geography, 75.0)
                    ORDER BY sw.geom <-> d.geom
                    LIMIT 1
                ) AS drain ON true
                WHERE sw.dataset_id = :dataset_id
                  AND (
                    sw.attributes->>'_canonical_class' = 'Standing_Water'
                    OR lower(coalesce(sw.attributes->>'gdb_layer', sw.category, ''))
                       IN ('standing_water', 'standing water', 'water_stagnation',
                           'water stagnation', 'waterlogging', 'water logging')
                  )
                """
            ),
            {"dataset_id": str(dataset_id)},
        )
    ).mappings().all()

    counts = {"red": 0, "yellow": 0, "green": 0}
    anomalies: list[SpatialAnomaly] = []
    for row in rows:
        attrs = dict(row["standing_water_attributes"] or {})
        geometry_area = _positive(_number(row["geometry_area_sqm"]))
        area, _, _ = _first_number(attrs, _AREA_ALIASES)
        area = _positive(area) or geometry_area
        depth_m = _depth_metres(attrs)
        direct_volume, _, _ = _first_number(attrs, _VOLUME_ALIASES)
        direct_volume = _positive(direct_volume)
        volume_m3 = direct_volume if direct_volume is not None else area * depth_m if area is not None and depth_m is not None else None

        road_distance = _positive(_number(row["road_distance_m"]))
        drain_distance = _positive(_number(row["drain_distance_m"]))
        road_intersects = bool(row["road_intersects"])
        drain_intersects = bool(row["drain_intersects"])
        score, color, reasons = standing_water_severity(
            area_sqm=area,
            road_distance_m=road_distance,
            road_intersects=road_intersects,
            drain_distance_m=drain_distance,
            drain_intersects=drain_intersects,
        )
        counts[color.value] += 1
        anomalies.append(
            SpatialAnomaly(
                dataset_id=dataset_id,
                ward=ward,
                anomaly_type=AnomalyType.STANDING_WATER_STATUS,
                color=color,
                severity_score=score,
                geom=f"SRID=4326;POINT({row['x']} {row['y']})",
                feature_ids=[row["standing_water_id"]],
                anomaly_metadata={
                    "standing_water_id": str(row["standing_water_id"]),
                    "source_layer": attrs.get("gdb_layer") or attrs.get("LAYER") or "Standing_Water",
                    "source_fid": attrs.get("FID") or attrs.get("OBJECTID"),
                    "area_sqm": round(area, 4) if area is not None else None,
                    "depth_m": round(depth_m, 4) if depth_m is not None else None,
                    "volume_m3": round(volume_m3, 4) if volume_m3 is not None else None,
                    "nearest_road_id": str(row["road_id"]) if row["road_id"] else None,
                    "nearest_road_label": row["road_label"],
                    "nearest_road_category": row["road_category"],
                    "nearest_road_distance_m": round(road_distance, 2) if road_distance is not None else None,
                    "intersects_road": road_intersects,
                    "nearest_drain_id": str(row["drain_id"]) if row["drain_id"] else None,
                    "nearest_drain_label": row["drain_label"],
                    "nearest_drain_category": row["drain_category"],
                    "nearest_drain_distance_m": round(drain_distance, 2) if drain_distance is not None else None,
                    "intersects_drain": drain_intersects,
                    "severity_label": _severity_label(score),
                    "reasons": reasons,
                    "evidence_source": "surveyed_gdb",
                    "volume_method": "surveyed" if direct_volume is not None else "area_times_depth" if volume_m3 is not None else "unavailable",
                },
            )
        )

    if anomalies:
        db.add_all(anomalies)
        await db.flush()
    return counts

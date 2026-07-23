"""AI Spatial Audit Engine — the three Phase 1 detection goals.

ALL geometry math here is deterministic PostGIS/Python — no LLM is ever
asked to reason about distances, clustering, or overlap. Findings are
persisted as SpatialAnomaly rows; a separate lazy step (see api/v1/ai.py's
/explain endpoint) asks Ollama to narrate an already-computed finding's
`anomaly_metadata`, never to compute it.

Goal 1 — Pole redundancy: DBSCAN-cluster all Illumination_Asset features
(Power Pole With Light / Light Pole / Solar Light / bare Power Pole treated
as one family). Within a cluster, one pole is kept (green), the rest are
flagged redundant (red). Isolated-but-close poles are flagged yellow.

Goal 2 — Building/drain encroachment: whether a row exists at all is
zero-tolerance, real geometry only — ST_Intersects(building, drain's
raw centerline), no buffer, no distance allowance. A building with any
visible gap to the drain is never flagged, full stop; this also covers
"Building Extenstions" (mapped to the same canonical_class as Building,
so a road-side extension that touches/crosses a drain is judged by
exactly the same rule as the main structure, not skipped).

Once a building genuinely touches a drain, RED vs YELLOW is NOT decided
by ST_Crosses — that was tried and doesn't work here: ST_Crosses tests
the drain's ENTIRE line (which runs on for tens/hundreds of metres past
many other buildings) against this one polygon, so it reads "has
interior points and exterior points" as true for nearly any real entry,
even a shallow corner clip, because the rest of the line far away is
obviously "outside" this building. That collapsed red/yellow into
almost all red. Instead:
  - Take just the piece of drain line inside THIS building
    (ST_Intersection) and measure its length — `chord_len_m`.
  - Compare it to the building's OWN size (`perimeter / 4`, its average
    side length) — never another building's size, so a shared wall in a
    row/terrace can't contaminate the measurement the way a shared
    vicinity buffer did in an earlier attempt.
  - `crossing_ratio = chord_len_m / building_span_m`
  - RED   : crossing_ratio > DRAIN_CROSSING_RED_RATIO — the drain runs
    most/all of the way across the building's own footprint.
  - YELLOW: 0 < crossing_ratio <= DRAIN_CROSSING_RED_RATIO — the drain
    only clips a fraction of the building (a corner, an edge).
  - GREEN (no anomaly row): the building never touches any drain.
DRAIN_BUFFER_M is separate and unrelated — it only estimates a physical
channel width for the descriptive `overlap_pct`/`overlap_area_m2`
figures shown in the tooltip/AI explanation, and plays no part in
deciding whether a row exists or what color it gets.

Goal 3 — Manhole status: every Access_Point (manhole) was actually
surveyed with its own Condition ("Good"/"Bad"/"Fair"/"Damage") — that is
the primary, most direct evidence and takes priority over any inferred
proxy:
  - Condition is a bad-token ("Bad", "Damage", ...) -> RED.
  - Top_Level is present but unparseable (e.g. "Blocked") -> RED — a
    literal recorded blockage, even stronger evidence than Condition.
  - Condition is a good-token ("Good", ...) -> GREEN.
  - Condition is recorded but neither clearly good nor bad (e.g. "Fair")
    -> YELLOW.
Only when the manhole's own row gives NO signal at all (no Condition, no
Top_Level entry — true for roughly half of this dataset) does the
detector fall back to secondary real evidence, in order: recorded
Silt_Level (siltation present -> YELLOW), then nearest-drain proximity
(the original goal-3 rule: red = directly at a closed drain within
MANHOLE_RED_DISTANCE_M, yellow = a closed drain nearby but farther off,
green = nearest drain is open or none found). Every manhole still gets a
row — there is no "quiet, unflagged" state, since confirming "this one's
fine" is itself useful.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dataset import Dataset
from app.models.point_verification import PointVerification
from app.models.spatial_anomaly import AnomalyColor, AnomalyStatus, AnomalyType, SpatialAnomaly
from app.services.manhole_recommend import classify_manhole_issue, is_bad_condition, is_good_condition, parse_level_m
from app.services.road_compat import backfill_road_classification
from app.services.road_width import detect_road_width_narrowing

# Per-class DBSCAN epsilon (meters). Only Illumination_Asset is clustered in
# Phase 1; other classes can get their own entry here later without touching
# the detector logic.
CLASS_EPS_M = {
    "Illumination_Asset": 5.0,
}
DEFAULT_EPS_M = 10.0
YELLOW_BAND_MULTIPLIER = 1.5  # borderline = between eps and eps * this

# Fraction of the building's OWN span (perimeter / 4) that the drain's
# chord inside it must exceed to count as a full crossing (RED) rather
# than a partial clip (YELLOW). See module docstring for why this
# replaced a plain ST_Crosses check.
DRAIN_CROSSING_RED_RATIO = 0.5

# Used ONLY to estimate a physical channel width for the descriptive
# overlap_pct/overlap_area_m2 figures (see module docstring) — never to
# decide whether a building counts as touching a drain.
DRAIN_BUFFER_M = 1.5

# ST_ClusterDBSCAN's `eps` is measured in the units of its input geometry's
# SRID — passing it raw EPSG:4326 geometry means "eps" is degrees (~111km
# each), not meters, silently chaining every feature in the dataset into one
# giant cluster regardless of the eps value. Must transform to a projected,
# metric CRS first. UTM zone 43N (EPSG:32643) covers Davangere/Karnataka.
_METRIC_SRID = 32643

# How far a manhole can be from a drain and still be considered "its" drain.
MANHOLE_DRAIN_MAX_M = 50.0
# Within this radius of a closed drain, the manhole is directly affected
# (red). Farther out but still within MANHOLE_DRAIN_MAX_M, a closed drain
# is a moderate/less certain concern (yellow) rather than a flat red —
# distance is real, measured data, not a guess. Tuned against the real
# Ghandinagar ward data: distances to the nearest closed drain range
# ~0.1-23m with a median of ~3m, so 5m gives a meaningful red/yellow split
# instead of nearly everything landing in red.
MANHOLE_RED_DISTANCE_M = 5.0

# Powerline proximity — three real distance tiers, not a flat "within X is
# dangerous": RED (critical, essentially touching), YELLOW (marginal, worth
# reviewing), GREEN (real clearance, confirmed OK) — same "every candidate
# gets a row, never a quiet unflagged state" philosophy as manhole_status.
# Buildings farther than POWERLINE_SEARCH_RADIUS_M aren't reported at all —
# clearly not "near" a powerline in any meaningful sense.
POWERLINE_RED_DISTANCE_M = 0.5
POWERLINE_YELLOW_DISTANCE_M = 1.0
POWERLINE_SEARCH_RADIUS_M = 1.5
# Kept as the historical/display name for the RED threshold in existing
# anomaly_metadata consumers.
POWERLINE_DANGER_DISTANCE_M = POWERLINE_RED_DISTANCE_M

# Fallback pole height when a pole exists nearby but has no real recorded
# height of its own — matches Map3DViewer.tsx's own DEFAULT_POLE_HEIGHT_M,
# so the backend's "is this building tall enough to reach the conductor"
# judgment lines up with what the 3D view actually draws the conductor at
# (the real nearest pole's height, not an independently-chosen constant).
DEFAULT_POLE_HEIGHT_M = 7.0


@dataclass(slots=True)
class AuditSummary:
    pole_redundancy: dict[str, int] = field(default_factory=dict)
    drain_encroachment: dict[str, int] = field(default_factory=dict)
    manhole_status: dict[str, int] = field(default_factory=dict)
    road_width_narrowing: dict[str, int] = field(default_factory=dict)
    powerline_proximity: dict[str, int] = field(default_factory=dict)


def _primary_feature_id(anomaly: SpatialAnomaly) -> str | None:
    metadata = anomaly.anomaly_metadata or {}
    value = (
        metadata.get("this_feature_id")
        or metadata.get("building_id")
        or metadata.get("manhole_id")
        or (anomaly.feature_ids[0] if anomaly.feature_ids else None)
    )
    return str(value) if value is not None else None


def _empty_counts() -> dict[str, int]:
    return {"red": 0, "yellow": 0, "green": 0}


def _pick_keep_pole(members: list[dict]) -> dict:
    """Deterministic tie-break for which pole in a redundant cluster stays
    green: prefer a combo asset (category containing 'with light'), else the
    lowest feature id (stable across re-runs)."""
    combo = [m for m in members if "with light" in (m["category"] or "").lower()]
    pool = combo if combo else members
    return min(pool, key=lambda m: str(m["id"]))


async def _detect_pole_redundancy(
    dataset_id: uuid.UUID, ward: str | None, db: AsyncSession
) -> dict[str, int]:
    eps = CLASS_EPS_M.get("Illumination_Asset", DEFAULT_EPS_M)
    yellow_band_m = eps * YELLOW_BAND_MULTIPLIER

    rows = (
        await db.execute(
            text(
                "SELECT id, category, ST_X(geom) AS x, ST_Y(geom) AS y, "
                f"ST_ClusterDBSCAN(ST_Transform(geom, {_METRIC_SRID}), eps := :eps, minpoints := 2) "
                "  OVER () AS cluster_id "
                "FROM features "
                "WHERE dataset_id = :dataset_id "
                "AND attributes->>'_canonical_class' = 'Illumination_Asset'"
            ),
            {"dataset_id": str(dataset_id), "eps": eps},
        )
    ).mappings().all()

    if not rows:
        return {"red": 0, "yellow": 0, "green": 0}

    clustered: dict[int, list[dict]] = {}
    noise_ids: list[str] = []
    by_id = {str(r["id"]): dict(r) for r in rows}
    for r in rows:
        if r["cluster_id"] is not None:
            clustered.setdefault(r["cluster_id"], []).append(dict(r))
        else:
            noise_ids.append(str(r["id"]))

    counts = {"red": 0, "yellow": 0, "green": 0}
    anomalies: list[SpatialAnomaly] = []

    for members in clustered.values():
        keep = _pick_keep_pole(members)
        member_ids = [m["id"] for m in members]
        for m in members:
            is_keep = m["id"] == keep["id"]
            color = AnomalyColor.GREEN if is_keep else AnomalyColor.RED
            counts["green" if is_keep else "red"] += 1
            anomalies.append(
                SpatialAnomaly(
                    dataset_id=dataset_id,
                    ward=ward,
                    anomaly_type=AnomalyType.POLE_REDUNDANCY,
                    color=color,
                    severity_score=10.0 if is_keep else min(100.0, 40.0 * (len(members) - 1)),
                    geom=f"SRID=4326;POINT({m['x']} {m['y']})",
                    feature_ids=member_ids,
                    anomaly_metadata={
                        "cluster_size": len(members),
                        "kept_feature_id": str(keep["id"]),
                        "kept_category": keep["category"],
                        "this_feature_id": str(m["id"]),
                        "this_category": m["category"],
                        "eps_m": eps,
                        "neighbor_categories": [mm["category"] for mm in members if mm["id"] != m["id"]],
                    },
                )
            )

    # Borderline check for noise (unclustered) poles: nearest same-class
    # neighbor within the yellow band but not tight enough to cluster.
    if noise_ids:
        nearest_rows = (
            await db.execute(
                text(
                    "SELECT a.id AS id, MIN(ST_Distance(a.geom::geography, b.geom::geography)) AS nearest_m "
                    "FROM features a JOIN features b "
                    "ON b.dataset_id = a.dataset_id AND b.id != a.id "
                    "AND b.attributes->>'_canonical_class' = 'Illumination_Asset' "
                    "WHERE a.dataset_id = :dataset_id AND a.id = ANY(:ids) "
                    "AND ST_DWithin(a.geom::geography, b.geom::geography, :band_m) "
                    "GROUP BY a.id"
                ),
                {"dataset_id": str(dataset_id), "ids": noise_ids, "band_m": yellow_band_m},
            )
        ).mappings().all()

        for r in nearest_rows:
            fid = str(r["id"])
            src = by_id[fid]
            counts["yellow"] += 1
            anomalies.append(
                SpatialAnomaly(
                    dataset_id=dataset_id,
                    ward=ward,
                    anomaly_type=AnomalyType.POLE_REDUNDANCY,
                    color=AnomalyColor.YELLOW,
                    severity_score=50.0,
                    geom=f"SRID=4326;POINT({src['x']} {src['y']})",
                    feature_ids=[src["id"]],
                    anomaly_metadata={
                        "this_feature_id": fid,
                        "this_category": src["category"],
                        "nearest_neighbor_m": round(float(r["nearest_m"]), 2),
                        "eps_m": eps,
                        "yellow_band_m": yellow_band_m,
                    },
                )
            )

    if anomalies:
        db.add_all(anomalies)
        await db.flush()
    return counts


async def _detect_drain_encroachment(
    dataset_id: uuid.UUID, ward: str | None, db: AsyncSession
) -> dict[str, int]:
    # See module docstring: whether a row exists at all is a strict, real
    # ST_Intersects against the drain's raw centerline (zero buffer, zero
    # tolerance) — includes Building Extenstions, since it shares the same
    # canonical_class as Building. RED vs YELLOW is then the length of
    # drain actually inside the building vs. the building's OWN span (not
    # a shared/neighbor-dependent denominator). DRAIN_BUFFER_M is separate
    # — used only afterwards for the descriptive overlap_pct/area.
    rows = (
        await db.execute(
            text(
                "WITH near_drains AS ( "
                "  SELECT b.id AS building_id, "
                "         ST_Union(ST_Buffer(d.geom::geography, :buffer_m)::geometry) AS drain_footprint, "
                "         sum(ST_Length(ST_Intersection(d.geom::geography, b.geom::geography))) AS chord_len_m, "
                "         array_agg(DISTINCT d.id) AS drain_ids, "
                "         array_agg(DISTINCT d.category) AS drain_categories, "
                "         array_agg(DISTINCT d.attributes->>'LAYER') AS drain_layers "
                "  FROM features b "
                "  JOIN features d ON d.dataset_id = b.dataset_id "
                "    AND d.attributes->>'_canonical_class' = 'Drainage_Asset' "
                "  WHERE b.dataset_id = :dataset_id "
                "    AND b.attributes->>'_canonical_class' = 'Building' "
                "    AND ST_Intersects(b.geom, d.geom) "
                "  GROUP BY b.id "
                ") "
                "SELECT b.id AS building_id, "
                "       ST_X(ST_Centroid(b.geom)) AS x, ST_Y(ST_Centroid(b.geom)) AS y, "
                "       nd.chord_len_m, nd.drain_ids, nd.drain_categories, nd.drain_layers, "
                "       ST_Area(b.geom::geography) AS building_area_m2, "
                "       ST_Perimeter(b.geom::geography) AS building_perim_m, "
                "       ST_Area(ST_Intersection(b.geom::geography, nd.drain_footprint::geography)) AS overlap_area_m2 "
                "FROM features b JOIN near_drains nd ON nd.building_id = b.id"
            ),
            {"dataset_id": str(dataset_id), "buffer_m": DRAIN_BUFFER_M},
        )
    ).mappings().all()

    counts = {"red": 0, "yellow": 0, "green": 0}
    anomalies: list[SpatialAnomaly] = []

    for r in rows:
        chord_len_m = float(r["chord_len_m"] or 0.0)
        building_perim_m = float(r["building_perim_m"] or 0.0)
        building_span_m = building_perim_m / 4.0
        crossing_ratio = min(1.0, chord_len_m / building_span_m) if building_span_m > 0 else 0.0

        building_area_m2 = float(r["building_area_m2"] or 0.0)
        overlap_area_m2 = float(r["overlap_area_m2"] or 0.0)
        pct = min(100.0, (overlap_area_m2 / building_area_m2) * 100.0) if building_area_m2 > 0 else 0.0

        crosses = crossing_ratio > DRAIN_CROSSING_RED_RATIO
        if crosses:
            color = AnomalyColor.RED
            severity = min(100.0, 60.0 + crossing_ratio * 40.0)
        else:
            color = AnomalyColor.YELLOW
            severity = min(59.0, 20.0 + crossing_ratio * 78.0)

        counts[color.value] += 1
        anomalies.append(
            SpatialAnomaly(
                dataset_id=dataset_id,
                ward=ward,
                anomaly_type=AnomalyType.DRAIN_ENCROACHMENT,
                color=color,
                severity_score=round(severity, 1),
                geom=f"SRID=4326;POINT({r['x']} {r['y']})",
                feature_ids=[r["building_id"], *r["drain_ids"]],
                anomaly_metadata={
                    "building_id": str(r["building_id"]),
                    "drain_crosses_building": crosses,
                    "crossing_ratio_pct": round(crossing_ratio * 100.0, 1),
                    "drain_chord_length_m": round(chord_len_m, 2),
                    "building_span_m": round(building_span_m, 2),
                    "overlap_pct": round(pct, 1),
                    "overlap_area_m2": round(overlap_area_m2, 2),
                    "building_area_m2": round(building_area_m2, 2),
                    "drain_buffer_m": DRAIN_BUFFER_M,
                    "drain_ids": [str(d) for d in r["drain_ids"]],
                    "drain_categories": r["drain_categories"],
                    "drain_layers": r["drain_layers"],
                },
            )
        )

    if anomalies:
        db.add_all(anomalies)
        await db.flush()
    return counts


async def _detect_manhole_status(
    dataset_id: uuid.UUID, ward: str | None, db: AsyncSession
) -> dict[str, int]:
    rows = (
        await db.execute(
            text(
                "SELECT m.id AS manhole_id, ST_X(m.geom) AS x, ST_Y(m.geom) AS y, "
                "       m.attributes AS attributes, "
                "       nearest.drain_id, nearest.drain_category, nearest.drain_attributes, nearest.distance_m "
                "FROM features m "
                "LEFT JOIN LATERAL ( "
                "  SELECT d.id AS drain_id, d.category AS drain_category, d.attributes AS drain_attributes, "
                "         ST_Distance(m.geom::geography, d.geom::geography) AS distance_m "
                "  FROM features d "
                "  WHERE d.dataset_id = m.dataset_id "
                "    AND d.attributes->>'_canonical_class' = 'Drainage_Asset' "
                "    AND ST_DWithin(m.geom::geography, d.geom::geography, :max_m) "
                "  ORDER BY m.geom <-> d.geom "
                "  LIMIT 1 "
                ") nearest ON true "
                "WHERE m.dataset_id = :dataset_id "
                "  AND m.attributes->>'_canonical_class' = 'Access_Point'"
            ),
            {"dataset_id": str(dataset_id), "max_m": MANHOLE_DRAIN_MAX_M},
        )
    ).mappings().all()

    counts = {"red": 0, "yellow": 0, "green": 0}
    anomalies: list[SpatialAnomaly] = []

    for r in rows:
        attrs = r["attributes"] or {}
        raw_condition = (attrs.get("Condition") or "").strip() or None
        raw_top_level = (attrs.get("Top_Level") or "").strip() or None
        raw_silt = (attrs.get("Silt_Level") or "").strip() or None
        raw_notes = (attrs.get("Notes") or attrs.get("Remarks") or "").strip() or None
        drain_category = (r["drain_category"] or "").lower()
        drain_attrs = r["drain_attributes"] or {}
        distance_m = r["distance_m"]

        # Real Sewage Line GIS data lets this be a stated fact, not a guess —
        # try every attribute key seen across survey layers for the drain's
        # own type/use/status text.
        drain_type_raw = (
            drain_attrs.get("Type")
            or drain_attrs.get("type")
            or drain_attrs.get("Type_of_Drain")
            or drain_attrs.get("Type_of_UGD")
            or drain_attrs.get("Drain_Type")
            or drain_attrs.get("drain_type")
            or ""
        ).lower()
        drain_use_raw = (
            drain_attrs.get("Use")
            or drain_attrs.get("use")
            or drain_attrs.get("Drain_Use")
            or drain_attrs.get("drain_use")
            or ""
        ).lower()
        ugd_status = (drain_attrs.get("UGD_Status") or drain_attrs.get("ugd_status") or "").lower()
        swd_status = (drain_attrs.get("SWD_Status") or drain_attrs.get("swd_status") or "").lower()

        is_sewage = (
            "sewage" in drain_type_raw or "sewer" in drain_type_raw
            or "sewage" in drain_use_raw or "sewer" in drain_use_raw
            or "sewage" in ugd_status or "sewer" in ugd_status
        )
        is_storm = "storm" in drain_type_raw or "storm" in drain_use_raw or "storm" in swd_status
        is_drainage = (
            "drain" in drain_category or "drain" in drain_type_raw
            or "drain" in drain_use_raw or "swd" in swd_status
        )

        issue_info = classify_manhole_issue(raw_condition, raw_top_level, raw_silt, raw_notes)

        if raw_top_level is not None and parse_level_m(raw_top_level) is None:
            # A recorded-but-unparseable level (e.g. "Blocked") is a literal
            # reported blockage — stronger evidence than Condition itself.
            color = AnomalyColor.RED
            basis = f"Top level recorded as \"{raw_top_level}\" — physically blocked"
        elif is_bad_condition(raw_condition):
            color = AnomalyColor.RED
            basis = f"Surveyed condition: \"{raw_condition}\""
        elif is_good_condition(raw_condition):
            color = AnomalyColor.GREEN
            basis = f"Surveyed condition: \"{raw_condition}\""
        elif raw_condition is not None:
            # A condition WAS recorded but isn't clearly good or bad (e.g.
            # "Fair") — genuinely ambiguous, not a guess either way.
            color = AnomalyColor.YELLOW
            basis = f"Surveyed condition: \"{raw_condition}\" (neither clearly good nor bad)"
        elif raw_silt is not None and raw_silt.lower() != "no":
            color = AnomalyColor.YELLOW
            basis = f"No condition recorded; silt level recorded at {raw_silt} — siltation present"
        elif "closed" in drain_category:
            # No direct signal on the manhole itself — fall back to the
            # original proxy: directly at/near a closed drain -> red,
            # nearby but farther off -> yellow (less certain this manhole
            # is the one affected).
            if distance_m is not None and distance_m <= MANHOLE_RED_DISTANCE_M:
                color = AnomalyColor.RED
            else:
                color = AnomalyColor.YELLOW
            basis = (
                f"No condition recorded; nearest drain is {r['drain_category']} and "
                f"{distance_m:.1f} m away" if distance_m is not None
                else f"No condition recorded; nearest drain is {r['drain_category']}"
            )
        else:
            color = AnomalyColor.GREEN
            basis = (
                "No condition recorded; nearest drain is open or none found nearby"
            )

        counts[color.value] += 1
        anomalies.append(
            SpatialAnomaly(
                dataset_id=dataset_id,
                ward=ward,
                anomaly_type=AnomalyType.MANHOLE_STATUS,
                color=color,
                severity_score={"red": 90.0, "yellow": 50.0, "green": 5.0}[color.value],
                geom=f"SRID=4326;POINT({r['x']} {r['y']})",
                feature_ids=[r["manhole_id"], *([r["drain_id"]] if r["drain_id"] else [])],
                anomaly_metadata={
                    "manhole_id": str(r["manhole_id"]),
                    "basis": basis,
                    "surveyed_condition": raw_condition,
                    "top_level": raw_top_level,
                    "silt_level": raw_silt,
                    "notes": raw_notes,
                    "primary_issue": issue_info["primary_issue"],
                    "issues": issue_info["issues"],
                    "severity_hint": issue_info["severity_hint"],
                    "nearest_drain_id": str(r["drain_id"]) if r["drain_id"] else None,
                    "nearest_drain_category": r["drain_category"],
                    "nearest_drain_distance_m": round(float(r["distance_m"]), 2) if r["distance_m"] is not None else None,
                    "max_search_radius_m": MANHOLE_DRAIN_MAX_M,
                    "connected_to_sewage": is_sewage,
                    "connected_to_storm": is_storm,
                    "connected_to_drainage": is_drainage,
                    "drain_type": (
                        drain_attrs.get("Type") or drain_attrs.get("type")
                        or drain_attrs.get("Type_of_Drain") or drain_attrs.get("Type_of_UGD")
                        or drain_attrs.get("Drain_Type") or drain_attrs.get("drain_type")
                    ),
                    "drain_use": (
                        drain_attrs.get("Use") or drain_attrs.get("use")
                        or drain_attrs.get("Drain_Use") or drain_attrs.get("drain_use")
                    ),
                },
            )
        )

    if anomalies:
        db.add_all(anomalies)
        await db.flush()
    return counts


_FLOOR_LEVEL_RE = re.compile(r"^G(?:\+(\d+))?$", re.IGNORECASE)


def _parse_floor_level_string(raw: str) -> int | None:
    """This survey records storeys as "G" (ground only, 1 storey) or "G+N"
    (ground + N upper storeys, N+1 total) under a "Floor" field — a real
    surveyed storey count under a different naming/format convention than
    the plain numeric floors/no_of_floors attributes handled below."""
    m = _FLOOR_LEVEL_RE.match(raw.strip())
    if not m:
        return None
    return int(m.group(1)) + 1 if m.group(1) else 1


def _extract_building_height_m(attributes: dict[str, Any] | None) -> float | None:
    """Case-insensitive scan for a real surveyed height/floor-count
    attribute — same convention the 3D viewer uses for its own building
    heights (Map3DViewer.tsx's readAttr/parseFloorLevelString), kept
    consistent here so a building this detector judges "too short to reach
    a conductor" matches what a user would actually see rendered in 3D."""
    if not attributes:
        return None
    for key, value in attributes.items():
        if key.lower() in ("height", "building_height", "elevation"):
            try:
                v = float(value)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                continue
            if v > 0:
                return v
    for key, value in attributes.items():
        if key.lower() in ("floors", "no_of_floors", "num_floors", "stories"):
            try:
                v = float(value)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                continue
            if v > 0:
                return v * 3.2  # ~3.2 m per floor, matching the 3D viewer's own estimate
    for key, value in attributes.items():
        if key.lower() == "floor" and isinstance(value, str):
            floors = _parse_floor_level_string(value)
            if floors:
                return floors * 3.2
    return None


async def _detect_powerline_proximity(
    dataset_id: uuid.UUID, ward: str | None, db: AsyncSession
) -> dict[str, int]:
    """Detect buildings within POWERLINE_SEARCH_RADIUS_M of REAL OVERHEAD
    power lines — but ONLY when the building is real tall enough to
    physically reach the nearest real pole's own conductor height in the
    first place. A single-storey building standing right under a 7 m
    overhead line has a genuine large vertical gap regardless of how close
    their footprints sit horizontally; flagging it as "dangerous" purely on
    2D distance would be a false positive. Only once the building's own
    real height reaches (or exceeds) the REAL nearest pole's own surveyed
    height (not a flat assumption — see _nearest_pole_height_m) does
    horizontal proximity become a real contact risk.

    The Power_Line canonical class also absorbs "Water Line" for layer
    grouping. A building's water/sewer service pipe running right into its
    own wall is completely normal and carries zero electrocution risk, so
    water raw categories are explicitly excluded from this join. "Electric
    Line" is treated as an overhead conductor elsewhere in the 3D UI, so it
    remains included here with real powerline categories.

    Every building that passes the height gate gets a row, colored by real
    distance tier (RED <= 0.5 m, YELLOW <= 1.0 m, GREEN beyond that but
    still within the search radius) — same "every candidate is reported,
    never a quiet unflagged state" philosophy as manhole_status, instead of
    a flat "dangerous or not shown at all" rule.

    Uses ST_DWithin with geography for accurate meter-based distance.
    """
    rows = (
        await db.execute(
            text(
                "SELECT b.id AS building_id, b.attributes AS building_attributes, "
                "       ST_X(ST_Centroid(b.geom)) AS x, ST_Y(ST_Centroid(b.geom)) AS y, "
                "       MIN(ST_Distance(b.geom::geography, p.geom::geography)) AS nearest_powerline_m, "
                "       array_agg(DISTINCT p.id) AS powerline_ids, "
                "       array_agg(DISTINCT p.category) AS powerline_categories "
                "FROM features b "
                "JOIN features p ON p.dataset_id = b.dataset_id "
                "  AND p.attributes->>'_canonical_class' = 'Power_Line' "
                "  AND p.category !~* 'water' "
                "WHERE b.dataset_id = :dataset_id "
                "  AND b.attributes->>'_canonical_class' = 'Building' "
                "  AND ST_DWithin(b.geom::geography, p.geom::geography, :radius_m) "
                "GROUP BY b.id"
            ),
            {"dataset_id": str(dataset_id), "radius_m": POWERLINE_SEARCH_RADIUS_M},
        )
    ).mappings().all()

    # Real pole positions + their own real height — used to judge each
    # candidate building against the REAL support nearest to it, instead of
    # one flat assumed conductor height. Matches the same convention
    # Map3DViewer.tsx uses to draw the conductor at the real pole's height.
    pole_rows = (
        await db.execute(
            text(
                "SELECT ST_X(geom) AS x, ST_Y(geom) AS y, attributes AS attrs, category "
                "FROM features "
                "WHERE dataset_id = :dataset_id "
                "  AND attributes->>'_canonical_class' IN ('Illumination_Asset', 'Utility_Pole') "
                "  AND ST_GeometryType(geom) = 'ST_Point'"
            ),
            {"dataset_id": str(dataset_id)},
        )
    ).mappings().all()
    poles = [
        (float(pr["x"]), float(pr["y"]), _extract_building_height_m(pr["attrs"]) or DEFAULT_POLE_HEIGHT_M)
        for pr in pole_rows
        if "solar" not in (pr["category"] or "").lower()
    ]

    def nearest_pole_height_m(x: float, y: float) -> float:
        if not poles:
            return DEFAULT_POLE_HEIGHT_M
        best_d2 = float("inf")
        best_h = DEFAULT_POLE_HEIGHT_M
        for px, py, ph in poles:
            d2 = (px - x) ** 2 + (py - y) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_h = ph
        return best_h

    counts = {"red": 0, "yellow": 0, "green": 0}
    anomalies: list[SpatialAnomaly] = []

    for r in rows:
        distance_m = float(r["nearest_powerline_m"] or 0.0)
        conductor_height_m = nearest_pole_height_m(float(r["x"]), float(r["y"]))

        building_height_m = _extract_building_height_m(r["building_attributes"])
        # Only skip when there's REAL surveyed evidence this building is
        # shorter than the REAL nearest pole's conductor height — no
        # height/floor-count attribute at all (true for every building in
        # some surveys) means genuinely unknown, not "safe". Treating
        # unknown as safe would silently turn this detector into a no-op on
        # any dataset that never recorded building height. Only a building
        # with a REAL recorded height/floor count below that real conductor
        # height is excluded; everything else still goes through the real
        # distance tiers below.
        if building_height_m is not None and building_height_m < conductor_height_m:
            continue

        if distance_m <= POWERLINE_RED_DISTANCE_M:
            color = AnomalyColor.RED
            counts["red"] += 1
            severity = 80.0 + (POWERLINE_RED_DISTANCE_M - distance_m) * 40.0
            tier_label = "critical"
        elif distance_m <= POWERLINE_YELLOW_DISTANCE_M:
            color = AnomalyColor.YELLOW
            counts["yellow"] += 1
            severity = 40.0 + (POWERLINE_YELLOW_DISTANCE_M - distance_m) * 40.0
            tier_label = "marginal — worth reviewing"
        else:
            color = AnomalyColor.GREEN
            counts["green"] += 1
            severity = 10.0
            tier_label = "real clearance — confirmed OK"

        height_note = (
            f"Building ({building_height_m:.1f} m tall) is"
            if building_height_m is not None
            else "Building is"
        )
        height_suffix = "" if building_height_m is not None else " (building height not surveyed)"

        anomalies.append(
            SpatialAnomaly(
                dataset_id=dataset_id,
                ward=ward,
                anomaly_type=AnomalyType.POWERLINE_PROXIMITY,
                color=color,
                severity_score=round(min(100.0, max(0.0, severity)), 1),
                geom=f"SRID=4326;POINT({r['x']} {r['y']})",
                feature_ids=[r["building_id"], *r["powerline_ids"]],
                anomaly_metadata={
                    "building_id": str(r["building_id"]),
                    "nearest_powerline_distance_m": round(distance_m, 2),
                    "red_threshold_m": POWERLINE_RED_DISTANCE_M,
                    "yellow_threshold_m": POWERLINE_YELLOW_DISTANCE_M,
                    "danger_threshold_m": POWERLINE_DANGER_DISTANCE_M,
                    "building_height_m": round(building_height_m, 2) if building_height_m is not None else None,
                    "nearest_pole_height_m": round(conductor_height_m, 2),
                    "powerline_ids": [str(pid) for pid in r["powerline_ids"]],
                    "powerline_categories": r["powerline_categories"],
                    "basis": (
                        f"{height_note} {distance_m:.2f} m from a power line "
                        f"(~{conductor_height_m:.1f} m conductor height, nearest real pole) — {tier_label}{height_suffix}"
                    ),
                },
            )
        )

    if anomalies:
        db.add_all(anomalies)
        await db.flush()
    return counts


async def run_spatial_audit(dataset_id: uuid.UUID, db: AsyncSession) -> AuditSummary:
    dataset = (
        await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    ).scalar_one_or_none()
    if dataset is None:
        raise ValueError(f"Dataset {dataset_id} not found")
    ward = dataset.ward

    # Upgrade legacy road taxonomy inside the same audit transaction. This is
    # idempotent and deterministic, and lets old persistent volumes participate
    # in Road AI Detection without requiring a dataset re-upload.
    await backfill_road_classification(db)

    # Preserve every finding already attached to any remediation workflow
    # across AI re-runs on the SAME dataset. The earlier implementation only
    # checked legacy Architect/Admin status values, which could delete an
    # anomaly used by an active AE/AEE/Commissioner task. A linked workflow
    # record is now the authoritative protection signal regardless of stage.
    protected_rows = (
        await db.execute(
            select(SpatialAnomaly)
            .join(PointVerification, PointVerification.anomaly_id == SpatialAnomaly.id)
            .where(SpatialAnomaly.dataset_id == dataset_id)
        )
    ).scalars().all()
    protected_ids = {row.id for row in protected_rows}
    protected_keys = {
        (row.anomaly_type, primary_id)
        for row in protected_rows
        if (primary_id := _primary_feature_id(row)) is not None
    }

    # Idempotent re-run: clear only unprotected open/reviewing findings.
    # Resolved/dismissed and remediation-linked rows are retained.
    delete_stmt = delete(SpatialAnomaly).where(
        SpatialAnomaly.dataset_id == dataset_id,
        SpatialAnomaly.status.in_([AnomalyStatus.OPEN, AnomalyStatus.REVIEWING]),
    )
    if protected_ids:
        delete_stmt = delete_stmt.where(SpatialAnomaly.id.notin_(protected_ids))
    await db.execute(delete_stmt)

    await _detect_pole_redundancy(dataset_id, ward, db)
    await _detect_drain_encroachment(dataset_id, ward, db)
    await _detect_manhole_status(dataset_id, ward, db)
    await detect_road_width_narrowing(dataset_id, ward, db)
    await _detect_powerline_proximity(dataset_id, ward, db)
    await db.flush()

    if protected_keys:
        generated_rows = (
            await db.execute(
                select(SpatialAnomaly).where(
                    SpatialAnomaly.dataset_id == dataset_id,
                    SpatialAnomaly.status.in_([AnomalyStatus.OPEN, AnomalyStatus.REVIEWING]),
                )
            )
        ).scalars().all()
        for row in generated_rows:
            primary_id = _primary_feature_id(row)
            if primary_id is not None and (row.anomaly_type, primary_id) in protected_keys:
                await db.delete(row)
        await db.flush()

    # Recalculate the visible counts after resolved-point de-duplication so
    # the run summary and map use the same persisted rows. Resolved findings
    # retain their original red/yellow evidence color but render blue because
    # their workflow status is resolved.
    visible = (
        await db.execute(
            select(SpatialAnomaly).where(
                SpatialAnomaly.dataset_id == dataset_id,
                SpatialAnomaly.status != AnomalyStatus.DISMISSED,
            )
        )
    ).scalars().all()
    counts = {
        AnomalyType.POLE_REDUNDANCY: _empty_counts(),
        AnomalyType.DRAIN_ENCROACHMENT: _empty_counts(),
        AnomalyType.MANHOLE_STATUS: _empty_counts(),
        AnomalyType.ROAD_WIDTH_NARROWING: _empty_counts(),
        AnomalyType.POWERLINE_PROXIMITY: _empty_counts(),
    }
    for row in visible:
        counts[row.anomaly_type][row.color.value] += 1

    await db.commit()
    return AuditSummary(
        pole_redundancy=counts[AnomalyType.POLE_REDUNDANCY],
        drain_encroachment=counts[AnomalyType.DRAIN_ENCROACHMENT],
        manhole_status=counts[AnomalyType.MANHOLE_STATUS],
        road_width_narrowing=counts[AnomalyType.ROAD_WIDTH_NARROWING],
        powerline_proximity=counts[AnomalyType.POWERLINE_PROXIMITY],
    )

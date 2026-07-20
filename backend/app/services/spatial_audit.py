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

import uuid
from dataclasses import dataclass, field

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dataset import Dataset
from app.models.point_verification import PointVerification, RemediationWorkflowStatus
from app.models.spatial_anomaly import AnomalyColor, AnomalyStatus, AnomalyType, SpatialAnomaly
from app.services.manhole_recommend import is_bad_condition, is_good_condition, parse_level_m

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


@dataclass(slots=True)
class AuditSummary:
    pole_redundancy: dict[str, int] = field(default_factory=dict)
    drain_encroachment: dict[str, int] = field(default_factory=dict)
    manhole_status: dict[str, int] = field(default_factory=dict)


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
                "       nearest.drain_id, nearest.drain_category, nearest.distance_m "
                "FROM features m "
                "LEFT JOIN LATERAL ( "
                "  SELECT d.id AS drain_id, d.category AS drain_category, "
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
        drain_category = (r["drain_category"] or "").lower()
        distance_m = r["distance_m"]

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
                    "nearest_drain_id": str(r["drain_id"]) if r["drain_id"] else None,
                    "nearest_drain_category": r["drain_category"],
                    "nearest_drain_distance_m": round(float(r["distance_m"]), 2) if r["distance_m"] is not None else None,
                    "max_search_radius_m": MANHOLE_DRAIN_MAX_M,
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

    # Preserve every finding already attached to the remediation workflow
    # across AI re-runs on the SAME dataset. This prevents a re-run from
    # orphaning active/rejected evidence or painting a new red duplicate on
    # top of a Commissioner-approved blue point.
    protected_rows = (
        await db.execute(
            select(SpatialAnomaly)
            .join(PointVerification, PointVerification.anomaly_id == SpatialAnomaly.id)
            .where(
                SpatialAnomaly.dataset_id == dataset_id,
                PointVerification.workflow_status.in_(
                    [
                        RemediationWorkflowStatus.WORK_IN_PROGRESS,
                        RemediationWorkflowStatus.PENDING_COMMISSIONER_APPROVAL,
                        RemediationWorkflowStatus.REJECTED_BY_COMMISSIONER,
                        RemediationWorkflowStatus.APPROVED_RESOLVED,
                    ]
                ),
            )
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
    }
    for row in visible:
        counts[row.anomaly_type][row.color.value] += 1

    await db.commit()
    return AuditSummary(
        pole_redundancy=counts[AnomalyType.POLE_REDUNDANCY],
        drain_encroachment=counts[AnomalyType.DRAIN_ENCROACHMENT],
        manhole_status=counts[AnomalyType.MANHOLE_STATUS],
    )

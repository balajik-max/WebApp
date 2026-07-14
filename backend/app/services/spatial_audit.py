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

Goal 2 — Building/drain encroachment: the total length of drain line
crossing a building is divided by the building's span (perimeter / 4)
to compute an encroachment percentage.  >= 80% -> RED (critical),
> 0% -> YELLOW (partial entry / graze), 0% -> GREEN (no anomaly row).

Goal 3 — Manhole status: for every Access_Point (manhole), find the nearest
Drainage_Asset and read its labeled open/closed status. Every manhole gets
a row — unlike goals 1-2, there's no "quiet, unflagged" state for a manhole,
since confirming "this one's fine" is itself useful. Red = directly at a
closed drain (within MANHOLE_RED_DISTANCE_M), yellow = a closed drain is
nearby but farther off (less certain this manhole is the one affected),
green = nearest drain is open or none found within range.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dataset import Dataset
from app.models.spatial_anomaly import AnomalyColor, AnomalyStatus, AnomalyType, SpatialAnomaly

# Per-class DBSCAN epsilon (meters). Only Illumination_Asset is clustered in
# Phase 1; other classes can get their own entry here later without touching
# the detector logic.
CLASS_EPS_M = {
    "Illumination_Asset": 5.0,
}
DEFAULT_EPS_M = 10.0
YELLOW_BAND_MULTIPLIER = 1.5  # borderline = between eps and eps * this

# Percentage-based drain encroachment: the total length of drain line
# passing through a building is expressed as a percentage of the building's
# "span" (= perimeter / 4, roughly the average side length). A drain that
# cuts fully across the building reaches ~100 %, a corner graze is a small
# percentage. Thresholds:
#   >= DRAIN_ENCROACH_RED_THRESHOLD_PCT  -> RED   (full crossing / critical)
#   > 0                                   -> YELLOW (partial / borderline)
#   0                                     -> GREEN  (no anomaly row created)
DRAIN_CONTACT_TOLERANCE_M = 0.25
DRAIN_ENCROACH_RED_THRESHOLD_PCT = 80.0

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
    # Percentage-based: the total length of drain line crossing through a
    # building is divided by the building's "span" (perimeter / 4, roughly
    # the average side length) to get an encroachment percentage.
    #   >= 80%      -> RED    (full/substantial crossing)
    #   > 0%        -> YELLOW (partial entry / graze)
    #   0%          -> GREEN  (no anomaly row)
    rows = (
        await db.execute(
            text(
                "WITH contacts AS ( "
                "  SELECT b.id AS building_id, "
                "         ST_X(ST_Centroid(b.geom)) AS x, "
                "         ST_Y(ST_Centroid(b.geom)) AS y, "
                "         d.id AS drain_id, "
                "         d.category AS drain_category, "
                "         d.attributes->>'LAYER' AS drain_layer, "
                "         ST_Distance(b.geom::geography, d.geom::geography) AS dist_m, "
                "         COALESCE(ST_Length(ST_Intersection(d.geom::geography, b.geom::geography)), 0) "
                "           AS overlap_len_m, "
                "         ST_Perimeter(b.geom::geography) AS building_perim_m "
                "  FROM features b "
                "  JOIN features d ON d.dataset_id = b.dataset_id "
                "    AND d.attributes->>'_canonical_class' = 'Drainage_Asset' "
                "  WHERE b.dataset_id = :dataset_id "
                "    AND b.attributes->>'_canonical_class' = 'Building' "
                "    AND ST_DWithin(b.geom::geography, d.geom::geography, :tol) "
                ") "
                "SELECT building_id, x, y, "
                "       min(dist_m) AS min_dist_m, "
                "       max(building_perim_m) AS building_perim_m, "
                "       sum(overlap_len_m) AS total_overlap_len_m, "
                "       array_agg(drain_id) AS drain_ids, "
                "       array_agg(drain_category) AS drain_categories, "
                "       array_agg(drain_layer) AS drain_layers "
                "FROM contacts "
                "GROUP BY building_id, x, y"
            ),
            {"dataset_id": str(dataset_id), "tol": DRAIN_CONTACT_TOLERANCE_M},
        )
    ).mappings().all()

    counts = {"red": 0, "yellow": 0, "green": 0}
    anomalies: list[SpatialAnomaly] = []

    for r in rows:
        min_dist_m = float(r["min_dist_m"] or 0.0)
        total_overlap_len_m = float(r["total_overlap_len_m"] or 0.0)
        building_perim_m = float(r["building_perim_m"] or 1.0)
        # Span = perimeter / 4 -> average side length of a rectangular
        # building.  overlap / span * 100  gives the % of a full crossing.
        pct = min(100.0, (total_overlap_len_m / (building_perim_m / 4)) * 100.0)

        if pct >= DRAIN_ENCROACH_RED_THRESHOLD_PCT:
            color = AnomalyColor.RED
            severity = 100.0
        elif pct > 0:
            color = AnomalyColor.YELLOW
            severity = 50.0
        else:
            continue

        counts[color.value] += 1
        anomalies.append(
            SpatialAnomaly(
                dataset_id=dataset_id,
                ward=ward,
                anomaly_type=AnomalyType.DRAIN_ENCROACHMENT,
                color=color,
                severity_score=severity,
                geom=f"SRID=4326;POINT({r['x']} {r['y']})",
                feature_ids=[r["building_id"], *r["drain_ids"]],
                anomaly_metadata={
                    "building_id": str(r["building_id"]),
                    "drain_touch_distance_m": round(min_dist_m, 2),
                    "drain_overlap_length_m": round(total_overlap_len_m, 2),
                    "overlap_pct": round(pct, 1),
                    "building_perim_m": round(building_perim_m, 2),
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
        drain_category = (r["drain_category"] or "").lower()
        distance_m = r["distance_m"]
        if "closed" in drain_category:
            # Directly at/near the closed drain -> red. Still within the
            # search radius but farther away -> yellow: a closed drain is
            # nearby, but this manhole isn't necessarily the one blocked.
            color = AnomalyColor.RED if (distance_m is not None and distance_m <= MANHOLE_RED_DISTANCE_M) else AnomalyColor.YELLOW
        else:
            # Open, or no nearby drain found at all / ambiguous label —
            # default to green (no evidence of a problem) rather than
            # flagging red on a guess.
            color = AnomalyColor.GREEN

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

    # Idempotent re-run: clear this dataset's own open/reviewing findings
    # first. resolved/dismissed rows are a human decision and are left alone.
    await db.execute(
        delete(SpatialAnomaly).where(
            SpatialAnomaly.dataset_id == dataset_id,
            SpatialAnomaly.status.in_([AnomalyStatus.OPEN, AnomalyStatus.REVIEWING]),
        )
    )

    summary = AuditSummary(
        pole_redundancy=await _detect_pole_redundancy(dataset_id, ward, db),
        drain_encroachment=await _detect_drain_encroachment(dataset_id, ward, db),
        manhole_status=await _detect_manhole_status(dataset_id, ward, db),
    )
    await db.commit()
    return summary

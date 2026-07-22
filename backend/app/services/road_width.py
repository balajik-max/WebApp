"""Road width narrowing detector — walks each Road_Centerline and measures
the real carriageway width against Road_Surface edge geometry, flagging
stations where the width drops suddenly.

Same discipline as app.services.spatial_audit: ALL geometry math here is
deterministic PostGIS/Python — no LLM is ever asked to reason about
distances or widths. Findings are persisted as SpatialAnomaly rows, exactly
like the other 3 audit detectors.

There is no polygon road surface anywhere in the real survey data this was
built against — Concrete Road / Concrete Edge / Road_Centerline are all
LineStrings — so width can't be read off a polygon cross-section. Instead,
at each sampled station along a centerline: cast a short perpendicular ray
to each side (PostGIS ST_Project/ST_Azimuth, not hand-rolled trig), and take
the nearest point where a Road_Surface line actually crosses that ray.
Width = distance between the two crossing points.

If a side finds no crossing within PROBE_LENGTH_M, that station is
low-confidence and is skipped entirely — never fabricated. This mirrors the
"never guessed, always computed" rule stated throughout
app.services.manhole_recommend (e.g. flow direction, pipe specs).

Constants below are grounded in the real Ghandinagar ward data: nearest-edge
distance from 224 centerline points to Concrete Road/Concrete Edge lines has
median 1.63 m, p90 2.72 m, max 3.66 m (n=224) — PROBE_LENGTH_M=8.0 clears
that with real margin for curves. 22 centerline lines, avg 129 m long.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.spatial_anomaly import AnomalyColor, AnomalyType, SpatialAnomaly
from app.services.road_compat import (
    ROAD_CENTERLINE_CATEGORY_KEYS,
    ROAD_CENTERLINE_CLASS,
    ROAD_SURFACE_CATEGORY_KEYS,
    ROAD_SURFACE_CLASS,
    road_class_predicate,
)

# How far apart along a centerline consecutive width samples are taken.
SAMPLE_INTERVAL_M = 5.0
# Max length of the perpendicular probe cast to each side of a station —
# see module docstring for the measured-distance grounding.
PROBE_LENGTH_M = 8.0
# How many of the most recent VALID (both-sides-found) widths feed the
# rolling average a new station is compared against.
ROLLING_WINDOW = 5
# drop_pct = (rolling_avg - width) / rolling_avg. Below YELLOW, not flagged.
YELLOW_DROP_RATIO = 0.20
RED_DROP_RATIO = 0.35
# A station is only ever compared once at least this many valid prior
# widths exist — flagging off a single, contextless prior sample isn't a
# real "narrowing," it's noise.
MIN_ROLLING_SAMPLES = 2


@dataclass(slots=True)
class _StationRow:
    line_id: str
    station_index: int
    lon: float
    lat: float
    left_edge_id: str | None
    left_edge_category: str | None
    right_edge_id: str | None
    right_edge_category: str | None
    width_m: float | None


# A flagged station plus the metrics computed for it at detection time.
@dataclass(slots=True)
class _FlaggedStation:
    row: _StationRow
    drop_pct: float
    rolling_avg: float
    color: AnomalyColor
    severity: float


async def _fetch_stations(dataset_id: uuid.UUID, db: AsyncSession) -> list[_StationRow]:
    rows = (
        await db.execute(
            text(
                "WITH centerlines AS ( "
                "  SELECT f.id AS line_id, (ST_Dump(f.geom)).geom AS geom "
                "  FROM features f "
                "  WHERE f.dataset_id = :dataset_id "
                f"    AND {road_class_predicate('f', ROAD_CENTERLINE_CLASS, 'road_centerline_categories')} "
                "), sized AS ( "
                "  SELECT line_id, geom, "
                "         ST_Length(geom::geography) AS len_m, "
                "         GREATEST(1, CEIL(ST_Length(geom::geography) / :interval_m)::int) AS n_steps "
                "  FROM centerlines "
                "  WHERE ST_Length(geom::geography) >= :interval_m * 2 "
                "), stations AS ( "
                "  SELECT line_id, geom AS line_geom, gs.i AS station_index, "
                "         LEAST(0.98, GREATEST(0.02, gs.i::float / n_steps)) AS frac "
                "  FROM sized "
                "  CROSS JOIN LATERAL generate_series(1, n_steps - 1) AS gs(i) "
                "), bearings AS ( "
                "  SELECT line_id, station_index, "
                "         ST_LineInterpolatePoint(line_geom, frac) AS pt, "
                "         ST_Azimuth( "
                "           ST_LineInterpolatePoint(line_geom, GREATEST(0.0, frac - 0.01)), "
                "           ST_LineInterpolatePoint(line_geom, LEAST(1.0, frac + 0.01)) "
                "         ) AS bearing "
                "  FROM stations "
                "), rays AS ( "
                "  SELECT line_id, station_index, pt, "
                "         ST_MakeLine(pt, ST_Project(pt::geography, CAST(:probe_m AS float8), bearing - pi() / 2)::geometry) AS left_ray, "
                "         ST_MakeLine(pt, ST_Project(pt::geography, CAST(:probe_m AS float8), bearing + pi() / 2)::geometry) AS right_ray "
                "  FROM bearings "
                ") "
                "SELECT r.line_id, r.station_index, ST_X(r.pt) AS lon, ST_Y(r.pt) AS lat, "
                "       le.edge_id AS left_edge_id, le.edge_category AS left_edge_category, "
                "       re.edge_id AS right_edge_id, re.edge_category AS right_edge_category, "
                "       CASE WHEN le.hit IS NOT NULL AND re.hit IS NOT NULL "
                "            THEN ST_Distance(le.hit::geography, re.hit::geography) END AS width_m "
                "FROM rays r "
                "LEFT JOIN LATERAL ( "
                "  SELECT s.id AS edge_id, s.category AS edge_category, "
                "         ST_ClosestPoint(ST_Intersection(s.geom, r.left_ray), r.pt) AS hit "
                "  FROM features s "
                "  WHERE s.dataset_id = :dataset_id "
                f"    AND {road_class_predicate('s', ROAD_SURFACE_CLASS, 'road_surface_categories')} "
                "    AND ST_DWithin(s.geom::geography, r.pt::geography, :probe_m) "
                "    AND ST_Intersects(s.geom, r.left_ray) "
                "  ORDER BY ST_Distance(r.pt::geography, ST_Intersection(s.geom, r.left_ray)::geography) "
                "  LIMIT 1 "
                ") le ON true "
                "LEFT JOIN LATERAL ( "
                "  SELECT s.id AS edge_id, s.category AS edge_category, "
                "         ST_ClosestPoint(ST_Intersection(s.geom, r.right_ray), r.pt) AS hit "
                "  FROM features s "
                "  WHERE s.dataset_id = :dataset_id "
                f"    AND {road_class_predicate('s', ROAD_SURFACE_CLASS, 'road_surface_categories')} "
                "    AND ST_DWithin(s.geom::geography, r.pt::geography, :probe_m) "
                "    AND ST_Intersects(s.geom, r.right_ray) "
                "  ORDER BY ST_Distance(r.pt::geography, ST_Intersection(s.geom, r.right_ray)::geography) "
                "  LIMIT 1 "
                ") re ON true "
                "ORDER BY r.line_id, r.station_index"
            ),
            {
                "dataset_id": str(dataset_id),
                "interval_m": SAMPLE_INTERVAL_M,
                "probe_m": PROBE_LENGTH_M,
                "road_centerline_categories": list(ROAD_CENTERLINE_CATEGORY_KEYS),
                "road_surface_categories": list(ROAD_SURFACE_CATEGORY_KEYS),
            },
        )
    ).mappings().all()

    return [
        _StationRow(
            line_id=str(r["line_id"]),
            station_index=r["station_index"],
            lon=float(r["lon"]),
            lat=float(r["lat"]),
            left_edge_id=str(r["left_edge_id"]) if r["left_edge_id"] else None,
            left_edge_category=r["left_edge_category"],
            right_edge_id=str(r["right_edge_id"]) if r["right_edge_id"] else None,
            right_edge_category=r["right_edge_category"],
            width_m=float(r["width_m"]) if r["width_m"] is not None else None,
        )
        for r in rows
    ]


# A narrowing "block" is a run of consecutive flagged stations along a
# centerline. Stations this many indices apart (or less) are joined into one
# continuous affected segment; a bigger gap starts a new block. Kept moderate
# so a brief missing-edge data gap doesn't split one real pinch-point, but
# two genuinely separate narrowings still become two blocks.
MAX_GAP_STATIONS = 4
# Each affected segment is padded by this many neighboring stations on both
# ends. The flagged stations sit 5 m apart, so without padding the drawn line
# only covers the sampled points and reads as a short dashed stub instead of
# the real carriageway stretch that narrowed. Padding extends the highlight to
# the true boundaries of the affected area (the transition where width returns
# to normal).
PAD_STATIONS = 2


def _segment_wkt(points: list[tuple[float, float]]) -> str:
    coord_str = ", ".join(f"{lon} {lat}" for lon, lat in points)
    return f"SRID=4326;LINESTRING({coord_str})"


def _centroid_point(points: list[tuple[float, float]]) -> str:
    n = len(points)
    lon = sum(p[0] for p in points) / n
    lat = sum(p[1] for p in points) / n
    return f"SRID=4326;POINT({lon} {lat})"


async def detect_road_width_narrowing(
    dataset_id: uuid.UUID, ward: str | None, db: AsyncSession
) -> dict[str, int]:
    stations = await _fetch_stations(dataset_id, db)

    counts = {"red": 0, "yellow": 0, "green": 0}
    anomalies: list[SpatialAnomaly] = []

    rolling: list[float] = []
    current_line: str | None = None
    # All stations of the current line, in order (for padding the segment to
    # its true boundaries), and only the flagged ones, buffered until flush.
    line_stations: list[_StationRow] = []
    flagged: list[_FlaggedStation] = []

    def flush_segments() -> None:
        if not flagged:
            return
        # Group consecutive flagged stations (by station_index) into runs.
        runs: list[list[_FlaggedStation]] = []
        run: list[_FlaggedStation] = []
        prev_idx: int | None = None
        for f in flagged:
            if prev_idx is None or (f.row.station_index - prev_idx) <= MAX_GAP_STATIONS:
                run.append(f)
            else:
                runs.append(run)
                run = [f]
            prev_idx = f.row.station_index
        if run:
            runs.append(run)

        # Map station_index -> ordered position in the full line, so we can pad
        # each run outward to the neighboring (possibly un-flagged) stations.
        idx_to_pos = {s.station_index: i for i, s in enumerate(line_stations)}

        for r in runs:
            first_pos = idx_to_pos[r[0].row.station_index]
            last_pos = idx_to_pos[r[-1].row.station_index]
            lo = max(0, first_pos - PAD_STATIONS)
            hi = min(len(line_stations) - 1, last_pos + PAD_STATIONS)
            # Padded span of stations — gives a continuous line to the real
            # narrowing boundaries, not just the sampled flagged points.
            padded = line_stations[lo : hi + 1]
            pts = [(s.lon, s.lat) for s in padded]
            # Representative metrics for the block: worst drop + mean widths
            # (computed over the flagged core, not the padding).
            worst = max(r, key=lambda f: f.drop_pct)
            mean_width = sum(f.row.width_m for f in r) / len(r)
            mean_avg = sum(f.rolling_avg for f in r) / len(r)
            color = worst.color
            counts[color.value] += 1
            anomalies.append(
                SpatialAnomaly(
                    dataset_id=dataset_id,
                    ward=ward,
                    anomaly_type=AnomalyType.ROAD_WIDTH_NARROWING,
                    color=color,
                    severity_score=round(worst.severity, 1),
                    geom=_centroid_point(pts),
                    feature_ids=[
                        uuid.UUID(r[0].row.line_id),
                        *([uuid.UUID(r[0].row.left_edge_id)] if r[0].row.left_edge_id else []),
                        *([uuid.UUID(r[0].row.right_edge_id)] if r[0].row.right_edge_id else []),
                    ],
                    anomaly_metadata={
                        "centerline_feature_id": r[0].row.line_id,
                        "left_edge_feature_id": r[0].row.left_edge_id,
                        "right_edge_feature_id": r[0].row.right_edge_id,
                        "left_edge_category": r[0].row.left_edge_category,
                        "right_edge_category": r[0].row.right_edge_category,
                        "affected_line_wkt": _segment_wkt(pts),
                        "width_m": round(mean_width, 2),
                        "rolling_avg_m": round(mean_avg, 2),
                        "drop_pct": round(worst.drop_pct * 100.0, 1),
                        "n_stations": len(r),
                        "padded_stations": len(padded),
                        "sample_interval_m": SAMPLE_INTERVAL_M,
                        "probe_length_m": PROBE_LENGTH_M,
                    },
                )
            )

    for st in stations:
        if st.line_id != current_line:
            # Line boundary — flush whatever we buffered for the previous line.
            flush_segments()
            line_stations = []
            flagged = []
            current_line = st.line_id
            rolling = []

        line_stations.append(st)

        if st.width_m is None:
            # Missing edge on at least one side — low-confidence, skip this
            # station entirely rather than guess. Rolling history is left
            # untouched so a brief data gap doesn't reset the baseline.
            continue

        if len(rolling) >= MIN_ROLLING_SAMPLES:
            rolling_avg = sum(rolling) / len(rolling)
            drop_pct = (rolling_avg - st.width_m) / rolling_avg if rolling_avg > 0 else 0.0

            if drop_pct >= YELLOW_DROP_RATIO:
                color = AnomalyColor.RED if drop_pct >= RED_DROP_RATIO else AnomalyColor.YELLOW
                severity = (
                    min(100.0, 60.0 + drop_pct * 100.0)
                    if color == AnomalyColor.RED
                    else min(59.0, 20.0 + drop_pct * 100.0)
                )
                flagged.append(_FlaggedStation(row=st, drop_pct=drop_pct, rolling_avg=rolling_avg, color=color, severity=severity))

        rolling.append(st.width_m)
        if len(rolling) > ROLLING_WINDOW:
            rolling.pop(0)

    flush_segments()  # flush the final line

    if anomalies:
        db.add_all(anomalies)
        await db.flush()
    return counts


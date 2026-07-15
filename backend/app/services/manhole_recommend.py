"""AI Manhole Recommendation Engine — Phase A.

Same discipline as app.services.spatial_audit: ALL geometry/graph math is
deterministic PostGIS/Python. Ollama (via app.services.ai.run_grounded_completion,
called only from api/v1/ai.py) narrates already-computed facts — it never
invents a level, a diameter, or a route.

This module's job is turning the real-but-messy free-text survey fields
(Top_Level="577.064", Depth="3 feet", Diameter="9 inches", WidthXDepth="3
feet X 1 feet") into clean floats, and providing a small standard pipe-size
table for the "upsize" recommendation. Nothing here reasons about location
or routing — see api/v1/ai.py's manhole-recommend endpoint for that.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Unit-aware parsing: survey fields mix metres, centimetres, feet and inches
# ("577.064", "5 m", "3 feet", "10 Inches", "2 Feet", "250"). We extract the
# number and an optional unit, then convert to a canonical unit so the same
# helper works for RLs (metres) and diameters (millimetres).
_NUMBER_UNIT_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*(cm|mm|m|ft|in|inch|feet|meters)?", re.IGNORECASE)

_UNIT_TO_M = {
    "m": 1.0, "meter": 1.0, "meters": 1.0,
    "cm": 0.01,
    "mm": 0.001,
    "ft": 0.3048, "feet": 0.3048,
    "in": 0.0254, "inch": 0.0254, "inches": 0.0254,
}
_UNIT_TO_MM = {
    "m": 1000.0, "meter": 1000.0, "meters": 1000.0,
    "cm": 10.0,
    "mm": 1.0,
    "ft": 304.8, "feet": 304.8,
    "in": 25.4, "inch": 25.4, "inches": 25.4,
}

# Standard commercial pipe diameters (mm) available for the upsize
# recommendation, per the plan's "150-500 mm" range.
STANDARD_PIPE_DIAMETERS_MM: list[int] = [150, 200, 225, 250, 300, 375, 450, 500]


def _extract_number_with_unit(raw, unit_table: dict, default_unit: str = "m") -> float | None:
    """Pull a number + optional unit from free text and convert to the
    canonical unit. Returns None when no number is present (e.g.
    Top_Level="Blocked") — never guessed."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    m = _NUMBER_UNIT_RE.search(text)
    if not m:
        return None
    value = float(m.group(1))
    unit = (m.group(2) or default_unit).lower()
    return value * unit_table.get(unit, unit_table.get(default_unit, 1.0))


def parse_level_m(raw: str | None) -> float | None:
    """Parse an RL (reduced level) field into metres ("577.064", "568.132 m").
    Returns None for non-numeric values (e.g. "Blocked")."""
    return _extract_number_with_unit(raw, _UNIT_TO_M, default_unit="m")


def parse_feet_to_m(raw: str | None) -> float | None:
    """Parse a depth/length measurement into metres ("3 feet", "1.5 m")."""
    return _extract_number_with_unit(raw, _UNIT_TO_M, default_unit="m")


def parse_inches_to_mm(raw: str | None) -> float | None:
    """Parse a diameter into millimetres ("10 Inches", "2 Feet", "250")."""
    return _extract_number_with_unit(raw, _UNIT_TO_MM, default_unit="mm")


def parse_width_x_depth_m(raw: str | None) -> tuple[float | None, float | None]:
    """Parse "3 feet X 1 feet" -> (width_m, depth_m)."""
    if not raw:
        return (None, None)
    parts = re.split(r"[xX]", raw)
    if len(parts) != 2:
        return (None, None)
    return (parse_feet_to_m(parts[0]), parse_feet_to_m(parts[1]))


def next_standard_diameter_mm(current_mm: float | None) -> float:
    """Round up to the next standard commercial pipe size. If the existing
    diameter is unknown, propose the smallest standard size rather than
    guessing a number — the assumption is stated by the caller."""
    if current_mm is None:
        return float(STANDARD_PIPE_DIAMETERS_MM[0])
    for size in STANDARD_PIPE_DIAMETERS_MM:
        if size >= current_mm:
            return float(size)
    return float(STANDARD_PIPE_DIAMETERS_MM[-1])


def recommend_material(existing_pipe_type: str | None, diameter_mm: float) -> str:
    """Prefer whatever material is already used nearby (consistency with
    the existing network); otherwise a standard default by size — RCC NP2
    for larger diameters (structural load), PVC for smaller ones (cost)."""
    if existing_pipe_type and existing_pipe_type.strip():
        return existing_pipe_type.strip()
    return "RCC NP2" if diameter_mm >= 300 else "PVC"


@dataclass(slots=True)
class ParsedLevels:
    """Every real, parsed numeric field for one Access_Point (Manhole) or
    Drainage_Level_Point row, plus the raw strings for anything that failed
    to parse (e.g. "Blocked") so the AI explanation can still mention it."""

    top_level_m: float | None
    bottom_level_m: float | None
    depth_m: float | None
    diameter_mm: float | None
    pipe_type: str | None
    condition: str | None
    silt_level_m: float | None
    width_m: float | None
    trench_depth_m: float | None
    raw_top_level: str | None
    raw_silt_level: str | None


def parse_levels(attrs: dict) -> ParsedLevels:
    width_m, trench_depth_m = parse_width_x_depth_m(attrs.get("WidthXDepth"))
    return ParsedLevels(
        top_level_m=parse_level_m(attrs.get("Top_Level")),
        bottom_level_m=parse_level_m(attrs.get("Bottom_Level")),
        depth_m=parse_feet_to_m(attrs.get("Depth")),
        diameter_mm=parse_inches_to_mm(attrs.get("Diameter")),
        pipe_type=(attrs.get("Pipe_Type") or "").strip() or None,
        condition=(attrs.get("Condition") or "").strip() or None,
        silt_level_m=parse_level_m(attrs.get("Silt_Level")),
        width_m=width_m,
        trench_depth_m=trench_depth_m,
        raw_top_level=(attrs.get("Top_Level") or "").strip() or None,
        raw_silt_level=(attrs.get("Silt_Level") or "").strip() or None,
    )


# ---------------------------------------------------------------------------
# Road-network graph + Dijkstra routing — strict, road-network-only.
#
# No pgRouting extension is installed, so the graph is built and searched in
# pure Python: every Road_Segment line is dumped to its individual vertices
# (ST_DumpPoints), consecutive vertices along the same line become a
# weighted edge (real geography distance), and endpoints within
# ROAD_SNAP_TOL_DEG of each other are merged so lines meeting at a real
# intersection are actually connected in the graph. A ward's road network is
# a few hundred vertices at most, so a linear-scan nearest-node lookup and
# a heapq Dijkstra are both fast enough without a spatial index.
# ---------------------------------------------------------------------------
import heapq
import math
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# Real gap distances between distinct Road_Segment/Sewage Line endpoints in
# this dataset: min 0.05 m, median 2.7 m, p75 5.0 m, p90 10.1 m — the same
# digitization-noise pattern seen throughout this data (roads that visibly
# meet were never digitized as literally touching). 2 m was too tight and
# left the graph fragmented into 27 disconnected islands; ~4.4 m merges most
# of the genuine noise while still leaving real, separate intersections
# (p90+) apart.
ROAD_SNAP_TOL_DEG = 4e-5  # ~4.4 m at this latitude
MANHOLE_CONNECT_MAX_M = 50.0  # matches spatial_audit.MANHOLE_DRAIN_MAX_M
BUILDING_CLEARANCE_M = 2.0  # a proposed point/route must stay this far from any Building


def _snap_key(x: float, y: float) -> tuple[float, float]:
    return (round(x / ROAD_SNAP_TOL_DEG) * ROAD_SNAP_TOL_DEG, round(y / ROAD_SNAP_TOL_DEG) * ROAD_SNAP_TOL_DEG)


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371000.0 * 2 * math.asin(min(1.0, math.sqrt(h)))


@dataclass(slots=True)
class RoadGraph:
    node_coords: dict[tuple[float, float], tuple[float, float]]
    adjacency: dict[tuple[float, float], list[tuple[tuple[float, float], float]]]


async def build_road_graph(dataset_id: uuid.UUID, db: AsyncSession) -> RoadGraph:
    rows = (
        await db.execute(
            text(
                "SELECT f.id AS line_id, (dp).path AS path, "
                "       ST_X((dp).geom) AS x, ST_Y((dp).geom) AS y "
                "FROM features f, LATERAL ST_DumpPoints(f.geom) AS dp "
                "WHERE f.dataset_id = :dataset_id "
                "  AND f.attributes->>'_canonical_class' = 'Road_Segment'"
            ),
            {"dataset_id": str(dataset_id)},
        )
    ).mappings().all()

    parts: dict[tuple, list[tuple[int, float, float]]] = {}
    for r in rows:
        path = list(r["path"])
        part_key = (r["line_id"], tuple(path[:-1]))
        parts.setdefault(part_key, []).append((path[-1], float(r["x"]), float(r["y"])))

    node_coords: dict[tuple[float, float], tuple[float, float]] = {}
    adjacency: dict[tuple[float, float], list[tuple[tuple[float, float], float]]] = {}

    def add_node(x: float, y: float) -> tuple[float, float]:
        key = _snap_key(x, y)
        node_coords.setdefault(key, (x, y))
        adjacency.setdefault(key, [])
        return key

    def add_edge(a: tuple[float, float], b: tuple[float, float]) -> None:
        weight = _haversine_m(node_coords[a], node_coords[b])
        if weight <= 0:
            return
        adjacency[a].append((b, weight))
        adjacency[b].append((a, weight))

    for points in parts.values():
        points.sort(key=lambda p: p[0])
        keys = [add_node(x, y) for _, x, y in points]
        for a, b in zip(keys, keys[1:]):
            if a != b:
                add_edge(a, b)

    return RoadGraph(node_coords=node_coords, adjacency=adjacency)


def nearest_graph_node(graph: RoadGraph, x: float, y: float) -> tuple[float, float] | None:
    if not graph.node_coords:
        return None
    return min(graph.node_coords, key=lambda k: _haversine_m(graph.node_coords[k], (x, y)))


def dijkstra(
    graph: RoadGraph, start: tuple[float, float], end: tuple[float, float]
) -> tuple[list[tuple[float, float]], float] | None:
    """Shortest path over the road graph. Returns (ordered lon/lat coordinates,
    total distance in metres), or None if unreachable."""
    if start not in graph.adjacency or end not in graph.adjacency:
        return None
    dist: dict[tuple[float, float], float] = {start: 0.0}
    prev: dict[tuple[float, float], tuple[float, float]] = {}
    visited: set[tuple[float, float]] = set()
    heap: list[tuple[float, tuple[float, float]]] = [(0.0, start)]
    while heap:
        d, node = heapq.heappop(heap)
        if node in visited:
            continue
        visited.add(node)
        if node == end:
            break
        for neighbor, weight in graph.adjacency.get(node, []):
            nd = d + weight
            if nd < dist.get(neighbor, float("inf")):
                dist[neighbor] = nd
                prev[neighbor] = node
                heapq.heappush(heap, (nd, neighbor))

    if end not in dist:
        return None

    path: list[tuple[float, float]] = [end]
    node = end
    while node != start:
        node = prev[node]
        path.append(node)
    path.reverse()
    return [graph.node_coords[n] for n in path], dist[end]


async def _build_pipe_graph(dataset_id: uuid.UUID, db: AsyncSession) -> RoadGraph:
    """Build a routing graph from the ACTUAL underground sewer/drainage pipes
    (not the road network). This is the topology the drainage network should
    follow: manholes are connected by the pipes that physically join them."""
    rows = (
        await db.execute(
            text(
                "SELECT f.id AS line_id, (dp).path AS path, "
                "       ST_X((dp).geom) AS x, ST_Y((dp).geom) AS y "
                "FROM features f, LATERAL ST_DumpPoints(f.geom) AS dp "
                "WHERE f.dataset_id = :dataset_id "
                "  AND (f.category ILIKE ANY(:cats) "
                "       OR f.attributes->>'_canonical_class' = 'Drainage_Asset')"
            ),
            {"dataset_id": str(dataset_id), "cats": list(PIPE_LINE_CATEGORIES)},
        )
    ).mappings().all()

    parts: dict[tuple, list[tuple[int, float, float]]] = {}
    for r in rows:
        path = list(r["path"])
        part_key = (r["line_id"], tuple(path[:-1]))
        parts.setdefault(part_key, []).append((path[-1], float(r["x"]), float(r["y"])))

    node_coords: dict[tuple[float, float], tuple[float, float]] = {}
    adjacency: dict[tuple[float, float], list[tuple[tuple[float, float], float]]] = {}

    def add_node(x: float, y: float) -> tuple[float, float]:
        key = _snap_key(x, y)
        node_coords.setdefault(key, (x, y))
        adjacency.setdefault(key, [])
        return key

    def add_edge(a: tuple[float, float], b: tuple[float, float]) -> None:
        weight = _haversine_m(node_coords[a], node_coords[b])
        if weight <= 0:
            return
        adjacency[a].append((b, weight))
        adjacency[b].append((a, weight))

    for points in parts.values():
        points.sort(key=lambda p: p[0])
        keys = [add_node(x, y) for _, x, y in points]
        for a, b in zip(keys, keys[1:]):
            if a != b:
                add_edge(a, b)

    return RoadGraph(node_coords=node_coords, adjacency=adjacency)


def dijkstra_to_all(
    graph: RoadGraph, start: tuple[float, float]
) -> tuple[dict[tuple[float, float], float], dict[tuple[float, float], tuple[float, float]]]:
    """Single-source shortest paths over the graph. Returns (dist, prev) for
    every reachable node — one Dijkstra call reaches all manholes, far cheaper
    than one Dijkstra per target."""
    dist: dict[tuple[float, float], float] = {start: 0.0}
    prev: dict[tuple[float, float], tuple[float, float]] = {}
    visited: set[tuple[float, float]] = set()
    heap: list[tuple[float, tuple[float, float]]] = [(0.0, start)]
    while heap:
        d, node = heapq.heappop(heap)
        if node in visited:
            continue
        visited.add(node)
        for neighbor, weight in graph.adjacency.get(node, []):
            nd = d + weight
            if nd < dist.get(neighbor, float("inf")):
                dist[neighbor] = nd
                prev[neighbor] = node
                heapq.heappush(heap, (nd, neighbor))
    return dist, prev


def path_from_prev(
    graph: RoadGraph, prev: dict[tuple[float, float], tuple[float, float]], start: tuple[float, float], end: tuple[float, float]
) -> list[tuple[float, float]] | None:
    if end not in prev and end != start:
        return None
    node = end
    out = [end]
    while node != start:
        node = prev[node]
        out.append(node)
    out.reverse()
    return [graph.node_coords[n] for n in out]


async def route_crosses_building(dataset_id: uuid.UUID, coords: list[tuple[float, float]], db: AsyncSession) -> bool:
    """The one hard rule from the plan: a candidate route must never run
    through a Building. Checked against the real geometry, not assumed
    safe just because it followed the road graph."""
    if len(coords) < 2:
        return False
    wkt = "LINESTRING(" + ", ".join(f"{x} {y}" for x, y in coords) + ")"
    return bool(
        (
            await db.execute(
                text(
                    "SELECT EXISTS(SELECT 1 FROM features b "
                    "WHERE b.dataset_id = :dataset_id "
                    "  AND b.attributes->>'_canonical_class' = 'Building' "
                    "  AND ST_Intersects(b.geom, ST_SetSRID(ST_GeomFromText(:wkt), 4326)))"
                ),
                {"dataset_id": str(dataset_id), "wkt": wkt},
            )
        ).scalar_one()
    )


async def build_safe_route(
    dataset_id: uuid.UUID,
    graph: RoadGraph,
    start_coord: tuple[float, float],
    end_coord: tuple[float, float],
    db: AsyncSession,
) -> tuple[list[tuple[float, float]], float] | None:
    """Every manhole should end up connected — the road graph in this data
    is fragmented into dozens of disconnected islands (real digitization
    gaps between road/sewage-line segments that visibly meet but were never
    drawn as literally touching), so a Dijkstra failure does NOT mean there
    is no safe path, only that the graph doesn't span it. Try, in order:
      1. Road/sewage-line-routed path (preferred — follows the real
         right-of-way), rejected if it crosses a Building.
      2. A direct straight line between the two points, ONLY if that line
         itself is verified clear of every Building — most manhole pairs
         are a few metres apart on the same street frontage, where a short
         direct line is realistically exactly where the pipe already runs.
    Returns None only when neither is safe — never a route that crosses a
    building, no matter how incomplete the road graph is.
    """
    start_node = nearest_graph_node(graph, start_coord[0], start_coord[1])
    end_node = nearest_graph_node(graph, end_coord[0], end_coord[1])
    result = start_node is not None and end_node is not None and dijkstra(graph, start_node, end_node)
    if result:
        coords, length_m = result
        if not await route_crosses_building(dataset_id, coords, db):
            return coords, length_m

    direct_coords = [start_coord, end_coord]
    if not await route_crosses_building(dataset_id, direct_coords, db):
        return direct_coords, _haversine_m(start_coord, end_coord)

    return None


# ---------------------------------------------------------------------------
# Connectivity — which manholes have no drain within a real threshold.
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class ManholeIssue:
    manhole_id: str
    lon: float
    lat: float
    reason: str
    nearest_drain_distance_m: float | None
    parsed: ParsedLevels


async def find_disconnected_manholes(dataset_id: uuid.UUID, db: AsyncSession) -> list[ManholeIssue]:
    rows = (
        await db.execute(
            text(
                "SELECT m.id AS manhole_id, ST_X(m.geom) AS x, ST_Y(m.geom) AS y, "
                "       m.attributes AS attributes, nearest.distance_m "
                "FROM features m "
                "LEFT JOIN LATERAL ( "
                "  SELECT ST_Distance(m.geom::geography, d.geom::geography) AS distance_m "
                "  FROM features d "
                "  WHERE d.dataset_id = m.dataset_id AND d.attributes->>'_canonical_class' = 'Drainage_Asset' "
                "  ORDER BY m.geom <-> d.geom LIMIT 1 "
                ") nearest ON true "
                "WHERE m.dataset_id = :dataset_id AND m.attributes->>'_canonical_class' = 'Access_Point'"
            ),
            {"dataset_id": str(dataset_id)},
        )
    ).mappings().all()

    issues: list[ManholeIssue] = []
    for r in rows:
        distance_m = float(r["distance_m"]) if r["distance_m"] is not None else None
        if distance_m is not None and distance_m <= MANHOLE_CONNECT_MAX_M:
            continue
        reason = (
            f"No drain found within {MANHOLE_CONNECT_MAX_M:.0f} m"
            if distance_m is None
            else f"Nearest drain is {distance_m:.1f} m away (beyond the {MANHOLE_CONNECT_MAX_M:.0f} m connectivity threshold)"
        )
        issues.append(
            ManholeIssue(
                manhole_id=str(r["manhole_id"]),
                lon=float(r["x"]),
                lat=float(r["y"]),
                reason=reason,
                nearest_drain_distance_m=distance_m,
                parsed=parse_levels(r["attributes"] or {}),
            )
        )
    return issues


# ---------------------------------------------------------------------------
# Coverage gaps — roadside points along a drain with no manhole nearby.
# Mirrors the 50 m ST_LineInterpolatePoint sampling already used for pole-
# spacing gaps in ai_context.py's needed_sql, applied to Drainage_Asset
# instead of roads, with an added Building-clearance + road-proximity check.
# ---------------------------------------------------------------------------
async def find_coverage_gaps(
    dataset_id: uuid.UUID, db: AsyncSession, max_results: int = 12
) -> list[dict]:
    rows = (
        await db.execute(
            text(
                "WITH drain_lines AS ( "
                "  SELECT (ST_Dump(f.geom)).geom AS geom "
                "  FROM features f "
                "  WHERE f.dataset_id = :dataset_id AND f.attributes->>'_canonical_class' = 'Drainage_Asset' "
                "), sampled AS ( "
                "  SELECT ST_LineInterpolatePoint( "
                "    geom, LEAST(0.98, GREATEST(0.02, gs.i / GREATEST(1.0, CEIL(ST_Length(geom::geography) / 50.0)))) "
                "  ) AS geom "
                "  FROM drain_lines "
                "  CROSS JOIN LATERAL generate_series(1, GREATEST(1, CEIL(ST_Length(geom::geography) / 50.0))::int - 1) AS gs(i) "
                "  WHERE ST_Length(geom::geography) >= 55 "
                "), manholes AS ( "
                "  SELECT f.geom FROM features f "
                "  WHERE f.dataset_id = :dataset_id AND f.attributes->>'_canonical_class' = 'Access_Point' "
                "), gaps AS ( "
                "  SELECT s.geom, MIN(ST_Distance(s.geom::geography, m.geom::geography)) AS nearest_manhole_m "
                "  FROM sampled s "
                "  LEFT JOIN manholes m ON ST_DWithin(s.geom::geography, m.geom::geography, 100) "
                "  GROUP BY s.geom "
                ") "
                "SELECT ST_X(g.geom) AS lon, ST_Y(g.geom) AS lat, g.nearest_manhole_m "
                "FROM gaps g "
                "WHERE (g.nearest_manhole_m IS NULL OR g.nearest_manhole_m > 50) "
                "  AND NOT EXISTS ( "
                "    SELECT 1 FROM features b WHERE b.dataset_id = :dataset_id "
                "      AND b.attributes->>'_canonical_class' = 'Building' "
                "      AND ST_DWithin(b.geom::geography, g.geom::geography, :clearance_m) "
                "  ) "
                "  AND EXISTS ( "
                "    SELECT 1 FROM features rd WHERE rd.dataset_id = :dataset_id "
                "      AND rd.attributes->>'_canonical_class' = 'Road_Segment' "
                "      AND ST_DWithin(rd.geom::geography, g.geom::geography, 15) "
                "  ) "
                "ORDER BY COALESCE(g.nearest_manhole_m, 9999) DESC "
                "LIMIT :limit"
            ),
            {
                "dataset_id": str(dataset_id),
                "clearance_m": BUILDING_CLEARANCE_M,
                "limit": max_results * 3,
            },
        )
    ).mappings().all()

    # De-dup near-identical gap points the same way ai_context.py's
    # needed_sql does, capped at max_results.
    selected: list[dict] = []
    for r in rows:
        coord = (float(r["lon"]), float(r["lat"]))
        if any(_haversine_m(coord, (s["lon"], s["lat"])) < 45.0 for s in selected):
            continue
        selected.append(
            {
                "lon": coord[0],
                "lat": coord[1],
                "nearest_manhole_m": float(r["nearest_manhole_m"]) if r["nearest_manhole_m"] is not None else None,
            }
        )
        if len(selected) >= max_results:
            break
    return selected


# ---------------------------------------------------------------------------
# Single-manhole ("feature" mode) recommendation — the connectivity check
# above only catches manholes with no nearby drain at all, but the real
# dataset's problems are mostly EXISTING, already-connected manholes in bad
# physical condition (44 of 78 are Condition="Bad") or with an unreadable
# level ("Blocked"). Both are real, grounded problems worth recommending
# against, so feature mode checks condition/level first and falls back to
# the connectivity graph only if the manhole itself looks fine.
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class PipeSpec:
    material: str
    diameter_mm: float
    from_rl: float | None
    to_rl: float | None
    slope: float | None


@dataclass(slots=True)
class PipeRoute:
    from_id: str
    to_id: str | None
    coordinates: list[tuple[float, float]]
    pipe_spec: PipeSpec


@dataclass(slots=True)
class FeatureRecommendation:
    manhole_id: str
    lon: float
    lat: float
    problem_type: str  # "blocked" | "bad_condition" | "disconnected" | "ok"
    reason: str
    parsed: ParsedLevels
    nearest_drain_distance_m: float | None
    route: PipeRoute | None


# Tokens that mark a manhole as physically failed in the free-text Condition
# field. Matched by substring (lowercased) so "Bad Condition", "Blocked",
# "Damage"/"Damaged Cover", "Choked", etc. all count — not only the exact
# string "bad". Real data in this dataset includes "Damage" (not
# "Damaged"), so the token itself must be the shorter root, not the other
# way around, or a real bad-condition row silently fails to match.
_BAD_CONDITION_TOKENS = (
    "bad", "blocked", "damage", "broken", "poor", "deteriorated",
    "choked", "collapsed", "defective", "cracked",
)
_GOOD_CONDITION_TOKENS = ("good", "fine", "ok", "working", "excellent", "satisfactory")


def is_bad_condition(condition: str | None) -> bool:
    if not condition:
        return False
    c = condition.strip().lower()
    return any(tok in c for tok in _BAD_CONDITION_TOKENS)


def is_good_condition(condition: str | None) -> bool:
    if not condition:
        return False
    c = condition.strip().lower()
    return any(tok in c for tok in _GOOD_CONDITION_TOKENS)


def _slope(from_rl: float | None, to_rl: float | None, length_m: float) -> float | None:
    # A chord shorter than ~1m (the manhole sits essentially at the drain
    # already) makes rise/run numerically meaningless — real RL noise of a
    # few cm would swing the "slope" wildly. Reporting None here is more
    # honest than a nonsense number the model might otherwise repeat verbatim.
    if from_rl is None or to_rl is None or length_m < 1.0:
        return None
    return round((from_rl - to_rl) / length_m, 4)


def _build_pipe_spec(parsed: ParsedLevels, nearby_diameter_mm: float | None, nearby_pipe_type: str | None) -> PipeSpec:
    """Build the pipe material/diameter for a recommendation. The RLs and
    slope are left None here and filled in by the caller once the REAL
    flow direction (manhole invert -> downstream drain invert) is known —
    they must not be derived from the manhole's own cover-to-invert depth."""
    baseline_diameter = parsed.diameter_mm if parsed.diameter_mm is not None else nearby_diameter_mm
    diameter_mm = next_standard_diameter_mm(baseline_diameter)
    material = recommend_material(parsed.pipe_type or nearby_pipe_type, diameter_mm)
    return PipeSpec(
        material=material,
        diameter_mm=diameter_mm,
        from_rl=None,
        to_rl=None,
        slope=None,
    )


async def _fetch_all_level_points(dataset_id: uuid.UUID, db: AsyncSession) -> list[dict]:
    """All Drainage_Level_Point rows (the real invert/pipe-spec survey layer)
    as plain dicts so a scan can find the nearest one to each manhole in
    Python instead of issuing one query per manhole."""
    rows = (
        await db.execute(
            text(
                "SELECT ST_X(geom) AS x, ST_Y(geom) AS y, attributes AS attributes "
                "FROM features "
                "WHERE dataset_id = :dataset_id AND attributes->>'_canonical_class' = 'Drainage_Level_Point'"
            ),
            {"dataset_id": str(dataset_id)},
        )
    ).mappings().all()
    return [{"lon": float(r["x"]), "lat": float(r["y"]), "attributes": r["attributes"] or {}} for r in rows]


def _nearest_level_point(level_points: list[dict], lon: float, lat: float, tol_m: float = 25.0) -> ParsedLevels | None:
    best = None
    best_d = tol_m
    for lp in level_points:
        d = _haversine_m((lon, lat), (lp["lon"], lp["lat"]))
        if d < best_d:
            best_d = d
            best = lp
    return parse_levels(best["attributes"]) if best else None


async def _fetch_manhole_rows(dataset_id: uuid.UUID, db: AsyncSession, manhole_id: uuid.UUID | None = None) -> list:
    """Fetch Access_Point rows with their nearest Drainage_Asset (distance,
    id, and the closest geometry point) in a single query. When manhole_id is
    given, only that one row is returned."""
    sql = (
        "SELECT m.id AS id, ST_X(m.geom) AS x, ST_Y(m.geom) AS y, m.attributes AS attributes, "
        "       nearest.distance_m, nearest.drain_id, "
        "       ST_X(nearest.nearest_point) AS nearest_x, ST_Y(nearest.nearest_point) AS nearest_y "
        "FROM features m "
        "LEFT JOIN LATERAL ( "
        "  SELECT d.id AS drain_id, "
        "         ST_Distance(m.geom::geography, d.geom::geography) AS distance_m, "
        "         ST_ClosestPoint(d.geom, m.geom) AS nearest_point "
        "  FROM features d "
        "  WHERE d.dataset_id = m.dataset_id AND d.attributes->>'_canonical_class' = 'Drainage_Asset' "
        "  ORDER BY m.geom <-> d.geom LIMIT 1 "
        ") nearest ON true "
        "WHERE m.dataset_id = :dataset_id "
        "  AND m.attributes->>'_canonical_class' = 'Access_Point'"
    )
    params: dict = {"dataset_id": str(dataset_id)}
    if manhole_id is not None:
        sql += " AND m.id = :manhole_id"
        params["manhole_id"] = str(manhole_id)
    return list((await db.execute(text(sql), params)).mappings().all())


async def analyze_manhole_row(
    dataset_id: uuid.UUID, row, db: AsyncSession, graph: RoadGraph, level_points: list[dict]
) -> FeatureRecommendation:
    attrs = row["attributes"] or {}
    parsed = parse_levels(attrs)
    distance_m = float(row["distance_m"]) if row["distance_m"] is not None else None
    lon, lat = float(row["x"]), float(row["y"])

    # A nearby Drainage_Level_Point (the real invert/pipe-spec survey layer)
    # fills in diameter/material AND the downstream invert RL when the
    # manhole's own row lacks them.
    nearby_parsed = _nearest_level_point(level_points, lon, lat)

    if parsed.raw_top_level is not None and parsed.top_level_m is None:
        problem_type = "blocked"
        reason = f"Top level reads \"{parsed.raw_top_level}\" — the manhole is recorded as physically blocked, not just a missing reading"
    elif is_bad_condition(parsed.condition):
        problem_type = "bad_condition"
        reason = f"Surveyed condition is \"{parsed.condition}\""
    elif distance_m is None or distance_m > MANHOLE_CONNECT_MAX_M:
        problem_type = "disconnected"
        reason = (
            f"No drain found within {MANHOLE_CONNECT_MAX_M:.0f} m"
            if distance_m is None
            else f"Nearest drain is {distance_m:.1f} m away (beyond the {MANHOLE_CONNECT_MAX_M:.0f} m connectivity threshold)"
        )
    else:
        problem_type = "ok"
        reason = f"Condition {parsed.condition or 'unrecorded'}, nearest drain {distance_m:.1f} m away — no issue found"

    route: PipeRoute | None = None
    if problem_type in ("blocked", "bad_condition") and row["nearest_x"] is not None:
        # Already connected, so this is a REHABILITATION at the existing
        # alignment — but "existing alignment" must still mean "along a
        # real road/sewage-line right-of-way", never a straight ruler-line
        # to the nearest drain point, which can and does cut straight
        # through a building whenever the nearest drain isn't immediately
        # adjacent (manholes/pipes are dug along roads and sewage lines,
        # not through the middle of a structure). Route it exactly like a
        # new connection: snap both ends onto the road graph, Dijkstra
        # between them, and only keep the route if it's verified clear of
        # every Building.
        target_coord = (float(row["nearest_x"]), float(row["nearest_y"]))
        spec = _build_pipe_spec(
            parsed,
            nearby_diameter_mm=nearby_parsed.diameter_mm if nearby_parsed else None,
            nearby_pipe_type=nearby_parsed.pipe_type if nearby_parsed else None,
        )
        # Flow direction is the REAL gradient: from the manhole invert
        # (Bottom_Level RL) down to the drain invert (the nearest
        # Drainage_Level_Point RL). A negative slope means the drain invert is
        # higher than the manhole invert — the connection would be uphill and
        # must be flagged (pumping / regrading), not silently reported as
        # gravity flow.
        manhole_invert = parsed.bottom_level_m
        if manhole_invert is None and parsed.top_level_m is not None and parsed.depth_m is not None:
            manhole_invert = parsed.top_level_m - parsed.depth_m
        drain_invert = nearby_parsed.top_level_m if (nearby_parsed and nearby_parsed.top_level_m is not None) else None

        safe = await build_safe_route(dataset_id, graph, (lon, lat), target_coord, db)
        if safe:
            coords, length_m = safe
            spec.from_rl = manhole_invert
            spec.to_rl = drain_invert
            spec.slope = _slope(manhole_invert, drain_invert, length_m)
            route = PipeRoute(
                from_id=str(row["id"]),
                to_id=str(row["drain_id"]) if row["drain_id"] else None,
                coordinates=coords,
                pipe_spec=spec,
            )
        # No safe path found (road-routed or straight-line, both checked
        # against every Building) — leave route=None. The finding itself
        # (problem_type/reason) is still reported either way.
    elif problem_type == "disconnected":
        # Route toward the nearest OTHER manhole, snapped onto the road graph.
        other = (
            await db.execute(
                text(
                    "SELECT ST_X(geom) AS x, ST_Y(geom) AS y FROM features "
                    "WHERE dataset_id = :dataset_id AND attributes->>'_canonical_class' = 'Access_Point' "
                    "  AND id != :manhole_id "
                    "ORDER BY geom <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326) LIMIT 1"
                ),
                {"dataset_id": str(dataset_id), "manhole_id": str(row["id"]), "lon": lon, "lat": lat},
            )
        ).mappings().one_or_none()
        if other is not None:
            other_coord = (float(other["x"]), float(other["y"]))
            safe = await build_safe_route(dataset_id, graph, (lon, lat), other_coord, db)
            if safe:
                coords, length_m = safe
                spec = _build_pipe_spec(
                    parsed,
                    nearby_diameter_mm=nearby_parsed.diameter_mm if nearby_parsed else None,
                    nearby_pipe_type=nearby_parsed.pipe_type if nearby_parsed else None,
                )
                spec.from_rl = parsed.bottom_level_m
                spec.to_rl = None  # no known downstream invert for a disconnected manhole
                spec.slope = _slope(parsed.bottom_level_m, None, length_m)
                route = PipeRoute(
                    from_id=str(row["id"]), to_id=None, coordinates=coords, pipe_spec=spec
                )

    return FeatureRecommendation(
        manhole_id=str(row["id"]),
        lon=lon,
        lat=lat,
        problem_type=problem_type,
        reason=reason,
        parsed=parsed,
        nearest_drain_distance_m=distance_m,
        route=route,
    )


async def build_feature_recommendation(
    dataset_id: uuid.UUID, manhole_id: uuid.UUID, db: AsyncSession, graph: RoadGraph | None = None
) -> FeatureRecommendation | None:
    rows = await _fetch_manhole_rows(dataset_id, db, manhole_id)
    if not rows:
        return None
    if graph is None:
        graph = await build_road_graph(dataset_id, db)
    level_points = await _fetch_all_level_points(dataset_id, db)
    return await analyze_manhole_row(dataset_id, rows[0], db, graph, level_points)


async def scan_all_manhole_recommendations(
    dataset_id: uuid.UUID, db: AsyncSession
) -> list[FeatureRecommendation]:
    """Ward-wide scan used by area mode: analyze every Access_Point once,
    with a single road-graph build and a single Drainage_Level_Point fetch,
    returning a recommendation (and route) for each. A single click must
    surface ALL bad manholes, not just one."""
    rows = await _fetch_manhole_rows(dataset_id, db)
    graph = await build_road_graph(dataset_id, db)
    level_points = await _fetch_all_level_points(dataset_id, db)
    return [await analyze_manhole_row(dataset_id, r, db, graph, level_points) for r in rows]


# ---------------------------------------------------------------------------
# Full drainage network — every manhole connected to its real downstream
# neighbour, with flow direction grounded in real elevation, in priority
# order (never guessed, never interpolated by the LLM):
#   1. The manhole's own surveyed invert (Bottom_Level, or Top_Level minus
#      Depth) — the most direct, physical evidence.
#   2. The real DTM (Digital Terrain Model) raster, sampled at the
#      manhole's exact coordinate — ground elevation at ~1-2 m resolution.
#   3. The nearest Elevation_Contour line's surveyed Elevation value — the
#      coarsest signal (a handful of contour lines for the whole ward), used
#      only when neither of the above is available.
# Flow direction is only ever asserted when both ends of a candidate edge
# have a real elevation from one of these three sources; otherwise the edge
# is still drawn (so the network stays visually complete) but its direction
# is explicitly marked unknown rather than invented.
# ---------------------------------------------------------------------------
NETWORK_CANDIDATE_RADIUS_M = 150.0  # how far to look for a manhole's local downstream neighbour
# How close a manhole must be to the sewage/drainage pipe network to be
# considered "on" it. Manholes farther than this fall back to a short
# straight-line link to their nearest neighbour.
PIPE_SNAP_TOLERANCE_M = 75.0
# Raw categories (or canonical class) that make up the underground sewer:
# these are the pipes that physically connect manholes, NOT roads.
PIPE_LINE_CATEGORIES = ("%sewage%", "%drain%", "%pipe%")


async def _find_dtm_dataset_id(db: AsyncSession) -> uuid.UUID | None:
    """Auto-detects the ward's DTM GeoTIFF by name, the same heuristic the
    3D plan view uses client-side — there is no explicit foreign key from a
    vector ward dataset to its DTM/DSM rasters in the schema."""
    row = (
        await db.execute(
            text("SELECT id FROM datasets WHERE file_type::text ILIKE 'geotiff' AND name ILIKE '%dtm%' LIMIT 1")
        )
    ).scalar_one_or_none()
    return row


async def _sample_dtm_elevation_m(dtm_dataset_id: uuid.UUID, lon: float, lat: float, db: AsyncSession) -> float | None:
    row = (
        await db.execute(text("SELECT storage_key FROM datasets WHERE id = :id"), {"id": str(dtm_dataset_id)})
    ).scalar_one_or_none()
    if not row:
        return None

    from app.services.storage import get_object_bytes

    try:
        raw_bytes = await get_object_bytes(row)
    except Exception:  # noqa: BLE001 — storage miss shouldn't break the network build
        return None

    import asyncio

    def _sample() -> float | None:
        import rasterio
        from rasterio.io import MemoryFile
        from rasterio.warp import transform as warp_transform

        with MemoryFile(raw_bytes) as memfile, memfile.open() as src:
            xs, ys = warp_transform("EPSG:4326", src.crs, [lon], [lat]) if src.crs else ([lon], [lat])
            values = list(src.sample(zip(xs, ys)))
            if not values or values[0].size == 0:
                return None
            value = float(values[0][0])
            if src.nodata is not None and value == src.nodata:
                return None
            return value

    return await asyncio.to_thread(_sample)


async def _nearest_contour_elevation_m(
    lon: float, lat: float, db: AsyncSession, max_m: float = 250.0
) -> float | None:
    """Contour lines are shared, ward-wide reference geometry uploaded as
    their own dataset — deliberately NOT scoped to the ward vector
    dataset_id, since they describe the physical terrain, not one survey."""
    row = (
        await db.execute(
            text(
                "SELECT (attributes->>'Elevation')::float AS elevation "
                "FROM features "
                "WHERE attributes->>'_canonical_class' = 'Elevation_Contour' "
                "  AND attributes->>'Elevation' IS NOT NULL "
                "  AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, :max_m) "
                "ORDER BY geom <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326) "
                "LIMIT 1"
            ),
            {"lon": lon, "lat": lat, "max_m": max_m},
        )
    ).mappings().one_or_none()
    return float(row["elevation"]) if row and row["elevation"] is not None else None


async def estimate_ground_elevation_m(
    lon: float, lat: float, db: AsyncSession, dtm_dataset_id: uuid.UUID | None
) -> tuple[float | None, str]:
    """Real ground elevation at one point, DTM raster first, contour lines
    as fallback. Returns (elevation_m_or_None, source_label) — the source
    label is always surfaced to the caller so "estimated from contour" is
    never silently indistinguishable from a real surveyed invert."""
    if dtm_dataset_id is not None:
        value = await _sample_dtm_elevation_m(dtm_dataset_id, lon, lat, db)
        if value is not None:
            return value, "dtm_raster"
    value = await _nearest_contour_elevation_m(lon, lat, db)
    if value is not None:
        return value, "nearest_contour"
    return None, "unknown"


async def _manhole_elevation_m(
    parsed: ParsedLevels, lon: float, lat: float, db: AsyncSession, dtm_dataset_id: uuid.UUID | None
) -> tuple[float | None, str]:
    """Ground elevation used to decide FLOW DIRECTION — DTM raster first,
    then the nearest contour line, and only then the manhole's own surveyed
    invert as a last resort. Terrain elevation is deliberately preferred over
    the surveyed reading here: Top_Level/Bottom_Level are hand-transcribed
    free-text values with real measurement/typo noise, which can locally
    disagree between two neighbouring manholes even along an obviously
    continuous slope — that noise is exactly what made the network's flow
    arrows flip direction pair-to-pair instead of all pointing consistently
    downhill. DTM/contour is smooth and physically consistent across the
    whole ward, so ordering it first keeps direction coherent along a chain."""
    value, source = await estimate_ground_elevation_m(lon, lat, db, dtm_dataset_id)
    if value is not None:
        return value, source
    if parsed.bottom_level_m is not None:
        return parsed.bottom_level_m, "surveyed_invert"
    if parsed.top_level_m is not None and parsed.depth_m is not None:
        return parsed.top_level_m - parsed.depth_m, "surveyed_top_minus_depth"
    if parsed.top_level_m is not None:
        return parsed.top_level_m, "surveyed_top_level"
    return None, "unknown"


@dataclass(slots=True)
class NetworkEdge:
    from_id: str
    to_id: str
    from_elevation_m: float | None
    to_elevation_m: float | None
    elevation_source: str
    flow_confirmed: bool  # True only when both ends have a real elevation and from > to
    route: PipeRoute | None
    rainy_season_closed: bool = False  # True if this manhole should be closed during rainy season to prevent water spreading
    # "sewage_line" when both manholes are snapped onto a real surveyed
    # sewage/drain pipe and the route follows it; "concrete_road" when no
    # such pipe path existed and the route instead follows the concrete
    # road network (which real sewage pipes run alongside/beneath in
    # practice) — always surfaced so a road-assisted guess is never
    # indistinguishable from a directly-surveyed pipe connection.
    route_basis: str = "sewage_line"


@dataclass(slots=True)
class UnconnectedManhole:
    """A manhole with no real sewage/drain pipe within PIPE_SNAP_TOLERANCE_M
    of it. Deliberately NOT given a fabricated straight-line connection to
    its geographically nearest neighbour — a line between two manholes that
    aren't actually joined by surveyed pipe geometry is not a real
    connection, and drawing one anyway is exactly what produced confusing,
    physically-nonsensical routes in earlier versions of this view. Instead
    it is surfaced as its own fact so the map/tooltip can say plainly: this
    manhole is not connected to the sewage line."""

    manhole_id: str
    lon: float
    lat: float
    reason: str


def _snap_manholes(
    graph: RoadGraph, manholes: list[dict], tolerance_m: float
) -> tuple[dict[str, tuple[float, float]], dict[str, float]]:
    node_for: dict[str, tuple[float, float]] = {}
    nearest_m: dict[str, float] = {}
    for m in manholes:
        n = nearest_graph_node(graph, m["lon"], m["lat"])
        if n is None:
            continue
        d = _haversine_m(graph.node_coords[n], (m["lon"], m["lat"]))
        nearest_m[m["id"]] = d
        if d <= tolerance_m:
            node_for[m["id"]] = n
    return node_for, nearest_m


async def _nearest_manhole_via_graph(
    dataset_id: uuid.UUID,
    graph: RoadGraph,
    node_for: dict[str, tuple[float, float]],
    manholes: list[dict],
    m: dict,
    db: AsyncSession,
) -> tuple[dict, list[tuple[float, float]], float] | None:
    """Nearest OTHER manhole reachable from `m`, walking the real pipe/road
    geometry (Dijkstra) rather than a straight line. Tried nearest-first;
    a candidate whose path would cut through a Building is skipped in
    favour of the next-nearest one — a real pipe/road can legitimately run
    close to a building's edge, but never draws a line through its middle,
    no matter which basis (sewage line, concrete road) it's grounded in.
    Returns None if `m` isn't snapped onto this graph, or no safe candidate
    shares its component."""
    snapped = node_for.get(m["id"])
    if snapped is None:
        return None
    dist, prev = dijkstra_to_all(graph, snapped)
    candidates: list[tuple[float, dict, tuple[float, float]]] = []
    for o in manholes:
        if o["id"] == m["id"]:
            continue
        on = node_for.get(o["id"])
        if on is None or on == snapped or on not in dist:
            continue
        candidates.append((dist[on], o, on))
    candidates.sort(key=lambda c: c[0])

    for d, target, on in candidates:
        path = path_from_prev(graph, prev, snapped, on)
        if not path:
            continue
        coords = [(m["lon"], m["lat"])] + path[1:-1] + [(target["lon"], target["lat"])]
        if await route_crosses_building(dataset_id, coords, db):
            continue
        return target, coords, d
    return None


def _uf_find(parent: dict[str, str], x: str) -> str:
    while parent.get(x, x) != x:
        x = parent[x]
    return x


def _uf_union(parent: dict[str, str], a: str, b: str) -> None:
    ra, rb = _uf_find(parent, a), _uf_find(parent, b)
    if ra != rb:
        parent[ra] = rb


async def _bridge_components(
    dataset_id: uuid.UUID,
    manholes: list[dict],
    pipe_graph: RoadGraph,
    road_graph: RoadGraph,
    node_for_pipe: dict[str, tuple[float, float]],
    node_for_road: dict[str, tuple[float, float]],
    raw_edges: dict[frozenset[str], "NetworkEdge"],
    db: AsyncSession,
) -> None:
    """The real underground network is one continuous system, but the
    nearest-neighbour pass above (plus real digitization gaps in the source
    survey layers) can still leave it split into several disjoint clusters —
    exactly the "some groups of manholes connect, not the whole network"
    problem this exists to fix. Repeatedly finds the two nearest manholes
    that sit in DIFFERENT clusters and connects them — preferring a real
    pipe path, then a real road path, and only falling back to a direct,
    building-checked line (flagged route_basis="bridge", the least-grounded
    of the three) when neither graph spans the gap — until every manhole is
    part of one single network. Mutates `raw_edges` in place."""
    parent: dict[str, str] = {m["id"]: m["id"] for m in manholes}
    for edge in raw_edges.values():
        _uf_union(parent, edge.from_id, edge.to_id)
    by_id = {m["id"]: m for m in manholes}

    async def _try_route(a: dict, b: dict) -> tuple[list[tuple[float, float]], float, str] | None:
        # Every candidate path is building-checked regardless of basis — a
        # bridging connection is still a line drawn on the map, and it must
        # never appear to cut through a structure any more than a primary
        # sewage/road connection would.
        an, bn = node_for_pipe.get(a["id"]), node_for_pipe.get(b["id"])
        if an is not None and bn is not None:
            result = dijkstra(pipe_graph, an, bn)
            if result:
                path_coords, length_m = result
                coords = [(a["lon"], a["lat"])] + path_coords[1:-1] + [(b["lon"], b["lat"])]
                if not await route_crosses_building(dataset_id, coords, db):
                    return coords, length_m, "sewage_line"
        an, bn = node_for_road.get(a["id"]), node_for_road.get(b["id"])
        if an is not None and bn is not None:
            result = dijkstra(road_graph, an, bn)
            if result:
                path_coords, length_m = result
                coords = [(a["lon"], a["lat"])] + path_coords[1:-1] + [(b["lon"], b["lat"])]
                if not await route_crosses_building(dataset_id, coords, db):
                    return coords, length_m, "concrete_road"
        direct = [(a["lon"], a["lat"]), (b["lon"], b["lat"])]
        if not await route_crosses_building(dataset_id, direct, db):
            return direct, _haversine_m((a["lon"], a["lat"]), (b["lon"], b["lat"])), "bridge"
        return None

    # Component-pairs (by root id) where EVERY manhole-pair between them has
    # already been tried and failed — skipped on later rounds so the loop
    # doesn't retry a genuinely unbridgeable pair forever, but crucially
    # never fakes a merge: unlike an earlier version of this pass, failure
    # here does NOT union the two components, so the map/UnconnectedManhole
    # output can never claim a connection that was never actually drawn.
    unbridgeable: set[frozenset[str]] = set()

    guard = 0
    max_guard = len(manholes) * 3
    while guard <= max_guard:
        guard += 1
        groups: dict[str, list[dict]] = {}
        for m in manholes:
            groups.setdefault(_uf_find(parent, m["id"]), []).append(m)
        if len(groups) <= 1:
            return

        # Every cross-component manhole pair not already known-unbridgeable,
        # sorted nearest-first — grouped implicitly by trying all pairs that
        # belong to the single nearest component-pair before moving on.
        comp_roots = list(groups.keys())
        candidates: list[tuple[float, dict, dict, frozenset[str]]] = []
        for i in range(len(comp_roots)):
            for j in range(i + 1, len(comp_roots)):
                comp_key = frozenset({comp_roots[i], comp_roots[j]})
                if comp_key in unbridgeable:
                    continue
                for a in groups[comp_roots[i]]:
                    for b in groups[comp_roots[j]]:
                        d = _haversine_m((a["lon"], a["lat"]), (b["lon"], b["lat"]))
                        candidates.append((d, a, b, comp_key))
        if not candidates:
            return  # every remaining component-pair is unbridgeable
        candidates.sort(key=lambda c: c[0])

        nearest_comp_key = candidates[0][3]
        found = False
        for _, a, b, comp_key in candidates:
            if comp_key != nearest_comp_key:
                break  # exhausted every pair for the nearest component-pair
            result = await _try_route(a, b)
            if result is None:
                continue
            coords, length_m, route_basis = result

            ae, be = a["elevation_m"], b["elevation_m"]
            if ae is not None and be is not None and ae >= be:
                frm, to, fcoords, frm_e, to_e, confirmed = a, b, coords, ae, be, True
            elif ae is not None and be is not None and ae < be:
                frm, to, fcoords, frm_e, to_e, confirmed = b, a, list(reversed(coords)), be, ae, True
            else:
                frm, to, fcoords, frm_e, to_e, confirmed = a, b, coords, ae, be, False

            spec = PipeSpec(
                material="PVC", diameter_mm=next_standard_diameter_mm(None),
                from_rl=frm_e, to_rl=to_e,
                slope=_slope(frm_e, to_e, length_m) if confirmed else None,
            )
            route = PipeRoute(from_id=frm["id"], to_id=to["id"], coordinates=fcoords, pipe_spec=spec)
            edge = NetworkEdge(
                from_id=frm["id"], to_id=to["id"], from_elevation_m=frm_e, to_elevation_m=to_e,
                elevation_source=by_id[frm["id"]]["source"], flow_confirmed=confirmed, route=route,
                rainy_season_closed=not confirmed, route_basis=route_basis,
            )
            raw_edges[frozenset({frm["id"], to["id"]})] = edge
            _uf_union(parent, a["id"], b["id"])
            found = True
            break

        if not found:
            unbridgeable.add(nearest_comp_key)


async def build_full_network(dataset_id: uuid.UUID, db: AsyncSession) -> tuple[list[NetworkEdge], list[UnconnectedManhole]]:
    """Build the complete manhole drainage network as ONE unified graph, not
    isolated clusters.

    Topology comes from the REAL underground sewer/drainage pipes first —
    each manhole is snapped onto the sewage/drain pipe network (within
    PIPE_SNAP_TOLERANCE_M) and connected to its nearest *other* manhole by
    walking the actual pipe (Dijkstra), so a "sewage_line"-basis line IS a
    real pipe stretch, never a fabricated shortcut. But the real sewage-line
    layer in a survey like this is often digitized in disconnected
    fragments (gaps where lines visibly meet but were never drawn as
    literally touching), which fractures the network into small disjoint
    clusters even though the real pipes underground are continuous. Rather
    than leave those fragments stranded, any manhole with no reachable
    neighbour on the sewage-pipe graph falls back to the CONCRETE ROAD
    network (Road_Segment, which real sewage pipes run alongside/beneath in
    practice almost everywhere) to find its nearest other manhole — marked
    with route_basis="concrete_road" so this assumption is never confused
    with a directly-surveyed pipe connection. Only a manhole with no path on
    EITHER network gets no route, reported as an UnconnectedManhole.

    Flow direction is decided entirely by terrain — each manhole's elevation
    is taken from the DTM raster first, then the contour lines, then the
    surveyed value (see _manhole_elevation_m), deliberately in that order so
    direction stays coherent along a chain instead of flipping pair-to-pair
    on noisy hand-surveyed levels. Every edge is stored pointing from the
    higher manhole to the lower one, so water visibly flows downhill. Pairs
    are deduplicated so each manhole pair appears once, preferring a
    sewage_line basis over a concrete_road one when both exist.
    """
    dtm_dataset_id = await _find_dtm_dataset_id(db)
    rows = await _fetch_manhole_rows(dataset_id, db)
    pipe_graph = await _build_pipe_graph(dataset_id, db)
    road_graph = await build_road_graph(dataset_id, db)

    manholes: list[dict] = []
    for r in rows:
        attrs = r["attributes"] or {}
        parsed = parse_levels(attrs)
        lon, lat = float(r["x"]), float(r["y"])
        elevation_m, source = await _manhole_elevation_m(parsed, lon, lat, db, dtm_dataset_id)
        manholes.append({
            "id": str(r["id"]), "lon": lon, "lat": lat,
            "elevation_m": elevation_m, "source": source,
            "condition": parsed.condition,
        })

    node_for_pipe, nearest_pipe_m = _snap_manholes(pipe_graph, manholes, PIPE_SNAP_TOLERANCE_M)
    node_for_road, nearest_road_m = _snap_manholes(road_graph, manholes, PIPE_SNAP_TOLERANCE_M)

    def straight_neighbours(m: dict, radius: float) -> list[tuple[float, dict]]:
        return [
            (_haversine_m((m["lon"], m["lat"]), (o["lon"], o["lat"])), o)
            for o in manholes
            if o["id"] != m["id"]
            and _haversine_m((m["lon"], m["lat"]), (o["lon"], o["lat"])) <= radius
        ]

    raw_edges: dict[frozenset[str], NetworkEdge] = {}  # keyed by frozenset({from_id, to_id})
    unconnected: list[UnconnectedManhole] = []

    for m in manholes:
        target: dict | None = None
        coords: list[tuple[float, float]] | None = None
        length_m = 0.0
        route_basis = "sewage_line"

        # Sewage-line connections are preferred (the real, directly-surveyed
        # pipe); concrete road is the fallback when no sewage-pipe path
        # exists. Both are tried nearest-candidate-first and skip any
        # candidate whose path would cut through a Building — never drawn
        # through a structure, regardless of which layer grounds the line.
        result = await _nearest_manhole_via_graph(dataset_id, pipe_graph, node_for_pipe, manholes, m, db)
        if result is not None:
            target, coords, length_m = result
            route_basis = "sewage_line"
        else:
            result = await _nearest_manhole_via_graph(dataset_id, road_graph, node_for_road, manholes, m, db)
            if result is not None:
                target, coords, length_m = result
                route_basis = "concrete_road"

        if target is None or coords is None:
            # No nearest-neighbour edge for this manhole yet — it may still
            # get one from _bridge_components below, which merges every
            # remaining disjoint cluster (including lone manholes like this
            # one) into a single network. Final unconnected status is
            # determined after that pass, not here.
            continue

        # Orient the edge downhill (higher elevation -> lower elevation) and
        # only mark flow confirmed when both ends have a real elevation.
        me, te = m["elevation_m"], target["elevation_m"]
        if me is not None and te is not None and me >= te:
            frm, to, fcoords = m, target, coords
            frm_e, to_e, confirmed = me, te, True
        elif me is not None and te is not None and me < te:
            frm, to, fcoords = target, m, list(reversed(coords))
            frm_e, to_e, confirmed = te, me, True
        else:
            frm, to, fcoords = m, target, coords
            frm_e, to_e, confirmed = me, te, False

        spec = PipeSpec(
            material="PVC",
            diameter_mm=next_standard_diameter_mm(None),
            from_rl=frm_e,
            to_rl=to_e,
            slope=_slope(frm_e, to_e, length_m) if confirmed else None,
        )
        route = PipeRoute(from_id=frm["id"], to_id=to["id"], coordinates=fcoords, pipe_spec=spec)

        # Rainy-season closure: bad/blocked condition, local low point, or
        # unconfirmed flow direction.
        has_bad_condition = is_bad_condition(m.get("condition"))
        near = straight_neighbours(m, NETWORK_CANDIDATE_RADIUS_M)
        is_local_low_point = (
            me is not None
            and bool(near)
            and all(o["elevation_m"] is None or me <= o["elevation_m"] for _, o in near)
        )
        rainy_season_closed = has_bad_condition or is_local_low_point or not confirmed

        edge = NetworkEdge(
            from_id=frm["id"],
            to_id=to["id"],
            from_elevation_m=frm_e,
            to_elevation_m=to_e,
            elevation_source=m["source"],
            flow_confirmed=confirmed,
            route=route,
            rainy_season_closed=rainy_season_closed,
            route_basis=route_basis,
        )

        # Deduplicate: only one edge per pair — prefer a directly-surveyed
        # sewage_line basis over a concrete_road guess, then the confirmed-
        # flow one, else the one whose direction is downhill (higher -> lower).
        pair_key = frozenset({frm["id"], to["id"]})
        if pair_key in raw_edges:
            existing = raw_edges[pair_key]
            if route_basis == "sewage_line" and existing.route_basis != "sewage_line":
                raw_edges[pair_key] = edge
            elif route_basis == existing.route_basis:
                if confirmed and not existing.flow_confirmed:
                    raw_edges[pair_key] = edge
                elif confirmed == existing.flow_confirmed:
                    if (frm_e or 0) > (existing.from_elevation_m or 0):
                        raw_edges[pair_key] = edge
        else:
            raw_edges[pair_key] = edge

    await _bridge_components(dataset_id, manholes, pipe_graph, road_graph, node_for_pipe, node_for_road, raw_edges, db)

    connected_ids = {e.from_id for e in raw_edges.values()} | {e.to_id for e in raw_edges.values()}
    for m in manholes:
        if m["id"] in connected_ids:
            continue
        nearest_m = nearest_pipe_m.get(m["id"])
        nearest_r = nearest_road_m.get(m["id"])
        reason = (
            "Not connected to the sewage line or a concrete road, and no safe bridge to "
            "the rest of the network was found — "
            f"nearest sewage/drain pipe is "
            f"{f'{nearest_m:.0f} m away' if nearest_m is not None else 'not found'}, "
            f"nearest concrete road is "
            f"{f'{nearest_r:.0f} m away' if nearest_r is not None else 'not found'}"
        )
        unconnected.append(UnconnectedManhole(manhole_id=m["id"], lon=m["lon"], lat=m["lat"], reason=reason))

    return list(raw_edges.values()), unconnected

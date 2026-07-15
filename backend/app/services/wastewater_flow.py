"""
Estimated Wastewater Flow Direction — candidate-connectivity + direction
classification for manhole point features.

IMPORTANT — what this module does NOT do:
There is no confirmed underground pipe LineString layer and no reliable
FROM_MANHOLE / TO_MANHOLE connectivity table in this project. This module
never fabricates either. It only produces *candidate* manhole-to-manhole
links built from strict spatial + road-name rules, and classifies each
link's flow direction using whatever elevation evidence the manhole's own
attributes actually contain. Every output segment carries
`connectivity_status = "spatially_inferred"` and an explicit confidence/
evidence trail — never "verified sewer network".

Pipeline (see PHASE 13 of the feature spec):
    Feature rows (category="manhole")
        -> normalize_manhole(...)          field aliasing, numeric parsing
        -> compute_invert(...)             elevation priority + validation
        -> build_candidate_links(...)      road grouping + distance rules
        -> classify_segment(...)           direction + confidence
        -> flow_geojson(...)               FeatureCollection assembly
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Literal

# ---------------------------------------------------------------------------
# Configuration constants (Phase 4, 6, 8, 9, 27) — intentionally simple
# module-level constants rather than a Settings() field, since these are
# algorithm tuning knobs for one derived-analytics feature, not deployment
# secrets/URLs like the rest of app/core/config.py.
# ---------------------------------------------------------------------------

#: Assumed unit for a bare numeric depth value with no unit text attached.
#: Documented explicitly in the API response and the frontend disclaimer —
#: never silently assumed without being surfaced.
DEFAULT_DEPTH_UNIT: Literal["feet", "metres"] = "feet"

DEPTH_MATCH_TOLERANCE_M = 0.15
DEPTH_WARNING_TOLERANCE_M = 0.30

MAX_LINK_DISTANCE_M = 100.0
MIN_LINK_DISTANCE_M = 0.5
MAX_NEIGHBOURS_PER_MANHOLE = 2

MIN_DIRECTION_DIFFERENCE_M = 0.02

MIN_REASONABLE_DEPTH_M = 0.20
MAX_REASONABLE_DEPTH_M = 20.0

MIN_SLOPE_PERCENT_WARNING = 0.05
MAX_SLOPE_PERCENT_WARNING = 10.0

FEET_TO_METRES = 0.3048

# ---------------------------------------------------------------------------
# Candidate-connectivity refinement constants (connectivity-refinement spec).
# A road name shared by spatially disconnected manhole groups, or a curved/
# branching road, previously produced diagonal cross-block "shortcut" links
# because the old algorithm sorted an entire same-road group along one
# single global axis. These constants control the fixes below.
# ---------------------------------------------------------------------------

#: Two same-road manholes belong to the same spatial cluster only if a chain
#: of hops each <= this distance connects them (connected-components graph).
CLUSTER_LINK_DISTANCE_M = 120.0

#: Local-alignment bearing check (Phase 4). A candidate whose bearing
#: deviates from the local road trend by more than this is rejected as an
#: unrealistic diagonal/cross-block link.
MAX_ALIGNMENT_ANGLE_DEG = 35.0
#: Number of nearby same-cluster points (excluding the pair itself) used to
#: estimate the local principal bearing around each endpoint.
LOCAL_ALIGNMENT_K = 4
#: Below this many usable nearby points, a stable local PCA bearing cannot
#: be trusted — fall back to nearest-sequential logic instead.
MIN_POINTS_FOR_LOCAL_ALIGNMENT = 3

#: Perpendicular corridor half-width (Phase 5) used to decide whether a
#: third point C lies "on" segment A-B closely enough that A-B is skipping
#: over it.
INTERMEDIATE_POINT_CORRIDOR_M = 15.0
#: C must project onto A-B within this fractional margin of the segment
#: (0.0-1.0 param space) to count as "between" A and B, not off one end.
INTERMEDIATE_POSITION_TOLERANCE = 0.05

#: Adaptive local-distance rule (Phase 6): a candidate is also rejected if
#: it exceeds this multiple of its cluster's median nearest-neighbour gap,
#: even when it is under the flat global MAX_LINK_DISTANCE_M.
DISTANCE_MULTIPLIER = 2.5

#: Junction / node-degree control (Phase 8).
MAX_JUNCTION_NEIGHBOURS_PER_MANHOLE = 3
#: Two branch bearings at a junction must differ by at least this much to
#: count as genuinely distinct directions (not near-duplicate candidates).
MIN_JUNCTION_BRANCH_SEPARATION_DEG = 40.0

#: Building-crossing check (Phase 11) — small tolerance in metres so a link
#: that merely grazes a polygon boundary/vertex is not falsely rejected.
BUILDING_CROSSING_TOLERANCE_M = 0.5

#: Road-corridor validation (Phase 10) — only applied when reliable road
#: LineString/MultiLineString geometry is supplied to build_candidate_links.
MAX_ROAD_CORRIDOR_OFFSET_M = 20.0

# ---------------------------------------------------------------------------
# Phase 3 — field alias tables (case-insensitive)
# ---------------------------------------------------------------------------

ID_ALIASES = ("MANHOLE_ID", "MH_ID", "FEATURE_ID", "ASSET_ID", "FID", "OBJECTID", "ID")
ROAD_ALIASES = ("ROAD_NAME", "ROAD", "STREET_NAME", "STREET")
TOP_LEVEL_ALIASES = ("TOP_LEVEL", "COVER_LEVEL", "RIM_LEVEL", "GROUND_LEVEL", "TOP_RL")
BOTTOM_LEVEL_ALIASES = (
    "BOTTOM_LEVEL", "INVERT_LEVEL", "BOTTOM_RL", "INVERT_RL", "BED_LEVEL", "PIPE_INVERT_LEVEL",
)
DEPTH_ALIASES = ("DEPTH", "MANHOLE_DEPTH", "MH_DEPTH")
X_ALIASES = ("X_LONG", "X", "EASTING", "LONGITUDE", "LNG", "LON")
Y_ALIASES = ("Y_LAT", "Y", "NORTHING", "LATITUDE", "LAT")

# This project's actual GDB import pipeline (see
# backend/app/services/analytics/readiness.py) uses these exact keys, so
# they are included alongside the spec's generic alias list.
TOP_LEVEL_ALIASES = TOP_LEVEL_ALIASES + ("Top_Level",)
BOTTOM_LEVEL_ALIASES = BOTTOM_LEVEL_ALIASES + ("Bottom_Level",)
DEPTH_ALIASES = DEPTH_ALIASES + ("Depth",)


def _find_alias(attributes: dict[str, Any], aliases: tuple[str, ...]) -> tuple[str, Any] | None:
    """Case-insensitive lookup of the first present alias. Returns (key, raw_value)."""
    if not attributes:
        return None
    lowered = {str(k).strip().lower(): (k, v) for k, v in attributes.items()}
    for alias in aliases:
        hit = lowered.get(alias.lower())
        if hit is not None and hit[1] is not None and str(hit[1]).strip() != "":
            return hit
    return None


# ---------------------------------------------------------------------------
# Phase 4 — safe numeric / depth parsing
# ---------------------------------------------------------------------------

_UNIT_TOKENS = {
    "feet": "feet", "foot": "feet", "ft": "feet",
    "metres": "metres", "meters": "metres", "metre": "metres", "meter": "metres", "m": "metres",
}
_TEXT_WITH_UNIT_RE = re.compile(
    r"^\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?\s*$"
)
_INVALID_TEXT_VALUES = {"", "-", "n/a", "na", "null", "none", "nan", "unknown", "blocked"}


@dataclass(frozen=True, slots=True)
class ParsedNumber:
    value: float | None
    unit: str | None  # "feet" | "metres" | None (no unit token found)
    raw: Any


def parse_numeric(raw: Any) -> ParsedNumber:
    """Safely parse a possibly-unitful numeric attribute value.

    Never raises. Invalid/blocked/empty text returns value=None. Preserves
    the original raw value for audit/popup display.
    """
    if raw is None:
        return ParsedNumber(None, None, raw)
    if isinstance(raw, bool):
        return ParsedNumber(None, None, raw)
    if isinstance(raw, (int, float)):
        if isinstance(raw, float) and (math.isnan(raw) or math.isinf(raw)):
            return ParsedNumber(None, None, raw)
        return ParsedNumber(float(raw), None, raw)

    text = str(raw).strip()
    if text.lower() in _INVALID_TEXT_VALUES:
        return ParsedNumber(None, None, raw)

    match = _TEXT_WITH_UNIT_RE.match(text)
    if not match:
        return ParsedNumber(None, None, raw)

    number_text, unit_text = match.groups()
    try:
        number = float(number_text)
    except ValueError:
        return ParsedNumber(None, None, raw)
    if math.isnan(number) or math.isinf(number):
        return ParsedNumber(None, None, raw)

    unit = None
    if unit_text:
        unit = _UNIT_TOKENS.get(unit_text.strip().lower())
        if unit is None:
            # Unrecognised trailing text (e.g. "3 apples") — treat as invalid
            # rather than silently dropping the unit and keeping the number.
            return ParsedNumber(None, None, raw)

    return ParsedNumber(number, unit, raw)


def parse_depth_metres(
    raw: Any, default_unit: Literal["feet", "metres"] = DEFAULT_DEPTH_UNIT
) -> tuple[float | None, str]:
    """Returns (depth_in_metres_or_None, unit_status).

    unit_status is one of "explicit" (unit text was present),
    "assumed_default" (bare number, fell back to default_unit), or
    "invalid" (value could not be parsed at all).
    """
    parsed = parse_numeric(raw)
    if parsed.value is None:
        return None, "invalid"
    if parsed.unit == "feet":
        return parsed.value * FEET_TO_METRES, "explicit"
    if parsed.unit == "metres":
        return parsed.value, "explicit"
    # No unit token — apply the configured default, but mark it ambiguous.
    if default_unit == "feet":
        return parsed.value * FEET_TO_METRES, "assumed_default"
    return parsed.value, "assumed_default"


# ---------------------------------------------------------------------------
# Phase 3/5 — normalized manhole record + elevation priority
# ---------------------------------------------------------------------------

InvertSource = Literal["direct_bottom", "top_minus_depth", "missing"]
InvertConfidence = Literal["direct", "derived", "unknown"]
ElevationValidation = Literal["consistent", "warning", "conflict", "not_checkable"]


@dataclass(slots=True)
class NormalizedManhole:
    manhole_id: str
    dataset_id: str
    #: Human-facing identifier (source FID/OBJECTID, or a stable fallback)
    #: for popups/labels — manhole_id itself stays the internal row id
    #: (guaranteed unique) so linking/segment-id logic never depends on
    #: whether a dataset happens to have a usable FID column.
    display_id: str
    road_name_raw: str | None
    road_name_normalized: str | None
    lon: float | None
    lat: float | None
    geometry_valid: bool

    top_level_m: float | None
    bottom_level_m: float | None
    depth_m: float | None
    depth_unit_status: str  # "explicit" | "assumed_default" | "invalid" | "not_present"

    usable_invert_m: float | None = None
    invert_source: InvertSource = "missing"
    invert_confidence: InvertConfidence = "unknown"

    elevation_validation: ElevationValidation = "not_checkable"
    depth_difference_m: float | None = None
    data_warnings: list[str] = field(default_factory=list)

    raw_attributes: dict[str, Any] = field(default_factory=dict)


def normalize_road_name(raw: str | None) -> str | None:
    if raw is None:
        return None
    collapsed = re.sub(r"\s+", " ", str(raw).strip())
    if not collapsed:
        return None
    return collapsed.lower()


def _extract_lon_lat(attributes: dict[str, Any], geometry: dict[str, Any] | None) -> tuple[float | None, float | None, bool]:
    """Geometry (already EPSG:4326 per this project's ingestion pipeline,
    see gis_reader.py) is authoritative. Attribute-level X/Y aliases are
    only used as a fallback when geometry is missing, and are NOT assumed
    to be longitude/latitude if they fall outside valid WGS84 ranges — in
    that case coordinates are treated as unusable rather than guessed."""
    if geometry and geometry.get("type") == "Point":
        coords = geometry.get("coordinates")
        if isinstance(coords, (list, tuple)) and len(coords) == 2:
            lon, lat = coords[0], coords[1]
            if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
                if -180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0:
                    return float(lon), float(lat), True
        return None, None, False

    x_hit = _find_alias(attributes, X_ALIASES)
    y_hit = _find_alias(attributes, Y_ALIASES)
    if not x_hit or not y_hit:
        return None, None, False
    x_parsed, y_parsed = parse_numeric(x_hit[1]), parse_numeric(y_hit[1])
    if x_parsed.value is None or y_parsed.value is None:
        return None, None, False
    lon, lat = x_parsed.value, y_parsed.value
    if -180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0:
        return lon, lat, True
    # Values exist but are outside valid lon/lat range — almost certainly a
    # projected CRS (e.g. UTM easting/northing). Per Phase 7: do not guess
    # the CRS or reproject blindly; mark unusable instead.
    return None, None, False


def normalize_manhole(
    manhole_id: str,
    dataset_id: str,
    attributes: dict[str, Any],
    geometry: dict[str, Any] | None,
    default_depth_unit: Literal["feet", "metres"] = DEFAULT_DEPTH_UNIT,
    display_id: str | None = None,
) -> NormalizedManhole:
    attributes = attributes or {}
    warnings: list[str] = []

    road_hit = _find_alias(attributes, ROAD_ALIASES)
    road_raw = str(road_hit[1]) if road_hit else None

    lon, lat, geom_ok = _extract_lon_lat(attributes, geometry)
    if not geom_ok:
        warnings.append("Coordinates missing, invalid, or not confirmed WGS84 — excluded from candidate linking.")

    top_hit = _find_alias(attributes, TOP_LEVEL_ALIASES)
    bottom_hit = _find_alias(attributes, BOTTOM_LEVEL_ALIASES)
    depth_hit = _find_alias(attributes, DEPTH_ALIASES)

    top_parsed = parse_numeric(top_hit[1]) if top_hit else ParsedNumber(None, None, None)
    bottom_parsed = parse_numeric(bottom_hit[1]) if bottom_hit else ParsedNumber(None, None, None)

    if top_hit and top_parsed.value is None:
        warnings.append(f"Top level value '{top_hit[1]}' could not be parsed as a number.")
    if bottom_hit and bottom_parsed.value is None:
        warnings.append(f"Bottom level value '{bottom_hit[1]}' could not be parsed as a number.")

    if depth_hit is None:
        depth_m, depth_unit_status = None, "not_present"
    else:
        depth_m, depth_unit_status = parse_depth_metres(depth_hit[1], default_depth_unit)
        if depth_unit_status == "invalid":
            warnings.append(f"Depth value '{depth_hit[1]}' could not be parsed as a number.")
        elif depth_unit_status == "assumed_default":
            warnings.append(
                f"Depth had no explicit unit — assumed default unit '{default_depth_unit}' (configurable)."
            )

    record = NormalizedManhole(
        manhole_id=manhole_id,
        dataset_id=dataset_id,
        display_id=display_id if display_id is not None else manhole_id,
        road_name_raw=road_raw,
        road_name_normalized=normalize_road_name(road_raw),
        lon=lon,
        lat=lat,
        geometry_valid=geom_ok,
        top_level_m=top_parsed.value,
        bottom_level_m=bottom_parsed.value,
        depth_m=depth_m,
        depth_unit_status=depth_unit_status,
        raw_attributes=attributes,
        data_warnings=warnings,
    )
    _compute_invert_and_validation(record)
    return record


def _compute_invert_and_validation(record: NormalizedManhole) -> None:
    """Phase 5 (elevation priority) + Phase 6 (consistency validation),
    mutating the record in place. Split out for readability/testability."""

    # --- Phase 5: elevation priority -------------------------------------
    if record.bottom_level_m is not None:
        record.usable_invert_m = record.bottom_level_m
        record.invert_source = "direct_bottom"
        record.invert_confidence = "direct"
    elif record.top_level_m is not None and record.depth_m is not None:
        record.usable_invert_m = record.top_level_m - record.depth_m
        record.invert_source = "top_minus_depth"
        record.invert_confidence = "derived"
    else:
        record.usable_invert_m = None
        record.invert_source = "missing"
        record.invert_confidence = "unknown"

    # --- Phase 6: consistency validation ----------------------------------
    have_all_three = (
        record.top_level_m is not None
        and record.bottom_level_m is not None
        and record.depth_m is not None
    )
    if have_all_three:
        calculated_depth_m = record.top_level_m - record.bottom_level_m
        diff = abs(calculated_depth_m - record.depth_m)
        record.depth_difference_m = diff
        if diff <= DEPTH_MATCH_TOLERANCE_M:
            record.elevation_validation = "consistent"
        elif diff <= DEPTH_WARNING_TOLERANCE_M:
            record.elevation_validation = "warning"
            record.data_warnings.append(
                f"Top/Bottom/Depth values disagree by {diff:.2f} m (warning tolerance)."
            )
        else:
            record.elevation_validation = "conflict"
            record.data_warnings.append(
                f"Top/Bottom/Depth values disagree by {diff:.2f} m (exceeds conflict tolerance)."
            )
    else:
        record.elevation_validation = "not_checkable"

    # Impossible-condition checks (independent of the three-value check above).
    if record.top_level_m is not None and record.bottom_level_m is not None:
        if record.bottom_level_m > record.top_level_m:
            record.elevation_validation = "conflict"
            record.data_warnings.append("Bottom/invert level is above top level — impossible.")

    if record.depth_m is not None:
        if record.depth_m < 0:
            record.elevation_validation = "conflict"
            record.data_warnings.append("Depth is negative — impossible.")
        elif record.depth_m == 0 and have_all_three and abs(record.top_level_m - record.bottom_level_m) > DEPTH_MATCH_TOLERANCE_M:
            record.elevation_validation = "conflict"
            record.data_warnings.append("Depth recorded as zero but top/bottom levels differ materially.")
        elif not (MIN_REASONABLE_DEPTH_M <= record.depth_m <= MAX_REASONABLE_DEPTH_M):
            record.data_warnings.append(
                f"Depth {record.depth_m:.2f} m is outside the typical review range "
                f"[{MIN_REASONABLE_DEPTH_M}, {MAX_REASONABLE_DEPTH_M}] m — flagged, not rejected."
            )

    # A conflict at this manhole means any direction touching it must be
    # downgraded — never silently confirmed off a disputed elevation.
    if record.elevation_validation == "conflict" and record.invert_source == "direct_bottom":
        record.invert_confidence = "conflict"


# ---------------------------------------------------------------------------
# Phase 7 — distance (metres) between two WGS84 points.
# Uses the haversine great-circle formula — adequate accuracy at the
# <=100m candidate-link scale this feature operates at, avoids adding a
# new geodesy dependency, and mirrors the same approach already used by
# the frontend's `haversineDistance` (MapCanvas.tsx) for the ruler tool.
# ---------------------------------------------------------------------------

_EARTH_RADIUS_M = 6371008.8


def haversine_distance_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    to_rad = math.radians
    d_lat = to_rad(lat2 - lat1)
    d_lon = to_rad(lon2 - lon1)
    h = (
        math.sin(d_lat / 2) ** 2
        + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(d_lon / 2) ** 2
    )
    return 2 * _EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


# ---------------------------------------------------------------------------
# Phase 8 — candidate connectivity (refined: spatial clustering, local
# alignment, intermediate-point rejection, adaptive distance, mutual-
# neighbour preference, junction control, crossing checks).
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class CandidateLink:
    manhole_a: NormalizedManhole
    manhole_b: NormalizedManhole
    distance_m: float
    road_name_normalized: str
    road_cluster_id: str = ""
    alignment_angle_deg: float | None = None
    alignment_status: str = "not_checked"  # "local_pca" | "fallback_sequential" | "not_checked"
    adaptive_max_distance_m: float | None = None
    neighbour_relationship: str = "sequential_one_sided"  # "mutual" | "sequential_one_sided" | "junction_candidate"
    is_junction: bool = False


def _pair_key(a_id: str, b_id: str) -> tuple[str, str]:
    return (a_id, b_id) if a_id <= b_id else (b_id, a_id)


def _dominant_axis(records: list[NormalizedManhole]) -> Literal["lon", "lat"]:
    lons = [r.lon for r in records if r.lon is not None]
    lats = [r.lat for r in records if r.lat is not None]
    lon_spread = (max(lons) - min(lons)) if lons else 0.0
    lat_spread = (max(lats) - min(lats)) if lats else 0.0
    return "lon" if lon_spread >= lat_spread else "lat"


def _axis_value(m: NormalizedManhole, axis: Literal["lon", "lat"] = "lon") -> float:
    value = m.lon if axis == "lon" else m.lat
    return value if value is not None else 0.0


def _principal_axis_order(records: list[NormalizedManhole]) -> list[NormalizedManhole]:
    """Order points along the dominant coordinate spread (a 1D PCA-
    equivalent for a small point set). Only ever called on ONE spatial
    cluster at a time (see _split_into_clusters) — applying this across
    disconnected clusters that merely share a road name is exactly what
    produced the diagonal cross-block links this refinement removes."""
    if len(records) < 2:
        return list(records)
    axis = _dominant_axis(records)
    return sorted(records, key=lambda r: _axis_value(r, axis))


def _bearing_deg(a: NormalizedManhole, b: NormalizedManhole) -> float:
    """Compass bearing in degrees [0, 360) from a to b, on the equirectangular
    approximation appropriate at this feature's <=100m link scale."""
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    d_lon = math.radians(b.lon - a.lon)
    y = math.sin(d_lon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(d_lon)
    deg = math.degrees(math.atan2(y, x))
    return (deg + 360) % 360


def _angle_difference_deg(bearing_a: float, bearing_b: float) -> float:
    """Orientation-insensitive angle difference — a road segment and its
    reverse direction (180 deg apart) are the same alignment."""
    diff = abs(bearing_a - bearing_b) % 360
    diff = min(diff, 360 - diff)
    return min(diff, 180 - diff) if diff > 90 else diff


# ---------------------------------------------------------------------------
# Phase 3 — spatial clustering (connected components within a road group).
# ---------------------------------------------------------------------------

def _split_into_clusters(
    group: list[NormalizedManhole],
    cluster_link_distance_m: float = CLUSTER_LINK_DISTANCE_M,
) -> list[list[NormalizedManhole]]:
    """Split a same-road-name group into spatially-connected components.
    Two points are in the same cluster only if a chain of hops, each
    <= cluster_link_distance_m, connects them — so a road name reused in
    two unrelated parts of town never gets treated as one continuous run."""
    n = len(group)
    if n <= 1:
        return [list(group)]

    adjacency: list[list[int]] = [[] for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            d = haversine_distance_m(group[i].lon, group[i].lat, group[j].lon, group[j].lat)
            if d <= cluster_link_distance_m:
                adjacency[i].append(j)
                adjacency[j].append(i)

    visited = [False] * n
    clusters: list[list[NormalizedManhole]] = []
    for start in range(n):
        if visited[start]:
            continue
        stack = [start]
        visited[start] = True
        component: list[int] = []
        while stack:
            node = stack.pop()
            component.append(node)
            for neighbour in adjacency[node]:
                if not visited[neighbour]:
                    visited[neighbour] = True
                    stack.append(neighbour)
        clusters.append([group[i] for i in component])
    return clusters


def _road_cluster_id(road_normalized: str, cluster_index: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", road_normalized).strip("-") or "road"
    return f"{slug}-cluster-{cluster_index + 1}"


# ---------------------------------------------------------------------------
# Phase 4 — local road-alignment validation.
# ---------------------------------------------------------------------------

def _local_bearing_deg(
    point: NormalizedManhole,
    cluster: list[NormalizedManhole],
    exclude_ids: set[str],
    k: int = LOCAL_ALIGNMENT_K,
) -> tuple[float | None, str]:
    """Local principal bearing around `point`, from up to k nearest other
    same-cluster points (excluding the candidate pair itself). Returns
    (bearing_or_None, status) — status is "local_pca" when enough nearby
    points exist, "fallback_sequential" otherwise (Phase 4 sparse-group rule)."""
    candidates = [
        m for m in cluster
        if m.manhole_id != point.manhole_id and m.manhole_id not in exclude_ids
    ]
    if len(candidates) < MIN_POINTS_FOR_LOCAL_ALIGNMENT:
        return None, "fallback_sequential"

    nearest = sorted(
        candidates,
        key=lambda m: haversine_distance_m(point.lon, point.lat, m.lon, m.lat),
    )[:k]
    axis = _dominant_axis([point] + nearest)
    ordered = sorted([point] + nearest, key=lambda m: _axis_value(m, axis))
    # Principal bearing = straight line between the extremes of the local
    # ordering — a lightweight 1D-PCA-equivalent direction for a small
    # local point set, consistent with _principal_axis_order elsewhere.
    if ordered[0].manhole_id == ordered[-1].manhole_id:
        return None, "fallback_sequential"
    return _bearing_deg(ordered[0], ordered[-1]), "local_pca"


def _check_alignment(
    a: NormalizedManhole,
    b: NormalizedManhole,
    cluster: list[NormalizedManhole],
    max_angle_deg: float = MAX_ALIGNMENT_ANGLE_DEG,
) -> tuple[bool, float | None, str]:
    """Returns (passes, angle_difference_deg_or_None, alignment_status)."""
    candidate_bearing = _bearing_deg(a, b)
    exclude = {a.manhole_id, b.manhole_id}
    bearing_a, status_a = _local_bearing_deg(a, cluster, exclude)
    bearing_b, status_b = _local_bearing_deg(b, cluster, exclude)

    local_bearings = [x for x in (bearing_a, bearing_b) if x is not None]
    if not local_bearings:
        # Too sparse for a stable local PCA — fall back to nearest-sequential
        # logic (i.e. accept; the distance/intermediate-point rules below
        # still guard against unrealistic links) but mark lower confidence.
        return True, None, "fallback_sequential"

    angle_diffs = [_angle_difference_deg(candidate_bearing, lb) for lb in local_bearings]
    worst = max(angle_diffs)
    status = "local_pca" if (status_a == "local_pca" or status_b == "local_pca") else "fallback_sequential"
    return worst <= max_angle_deg, worst, status


# ---------------------------------------------------------------------------
# Phase 5 — prevent skipping intermediate manholes.
# ---------------------------------------------------------------------------

def _point_segment_projection(
    px: float, py: float, ax: float, ay: float, bx: float, by: float,
) -> tuple[float, float]:
    """Returns (t, perpendicular_distance) where t in [0,1] parameterises
    the projection of P onto segment A-B (0=A, 1=B), in a local planar
    approximation adequate at <=100m scale (matches the rest of this
    module's haversine-based, non-geodesic-library approach)."""
    abx, aby = bx - ax, by - ay
    seg_len_sq = abx * abx + aby * aby
    if seg_len_sq == 0:
        return 0.0, math.hypot(px - ax, py - ay)
    t = ((px - ax) * abx + (py - ay) * aby) / seg_len_sq
    proj_x, proj_y = ax + t * abx, ay + t * aby
    perp = math.hypot(px - proj_x, py - proj_y)
    return t, perp


def _skips_intermediate_manhole(
    a: NormalizedManhole,
    b: NormalizedManhole,
    cluster: list[NormalizedManhole],
    corridor_m: float = INTERMEDIATE_POINT_CORRIDOR_M,
    position_tolerance: float = INTERMEDIATE_POSITION_TOLERANCE,
) -> bool:
    """True if some other same-cluster point C lies close to and between
    A and B, meaning A-B is an unrealistic jump over a closer sequential
    point rather than a direct neighbour connection."""
    # Degrees-to-metres scale factors for the local planar projection —
    # only used to keep the corridor tolerance in real metres; the
    # comparison itself stays consistent since both axes use the same
    # local approximation across a small (<=100m) segment.
    lat_scale = 111_320.0
    lon_scale = 111_320.0 * math.cos(math.radians((a.lat + b.lat) / 2))

    ax, ay = a.lon * lon_scale, a.lat * lat_scale
    bx, by = b.lon * lon_scale, b.lat * lat_scale

    for c in cluster:
        if c.manhole_id in (a.manhole_id, b.manhole_id):
            continue
        cx, cy = c.lon * lon_scale, c.lat * lat_scale
        t, perp = _point_segment_projection(cx, cy, ax, ay, bx, by)
        if (
            position_tolerance <= t <= (1 - position_tolerance)
            and perp <= corridor_m
        ):
            return True
    return False


# ---------------------------------------------------------------------------
# Phase 6 — adaptive local-distance rule.
# ---------------------------------------------------------------------------

def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    return ordered[mid] if n % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def _cluster_adaptive_max_distance(
    cluster: list[NormalizedManhole],
    max_link_distance_m: float,
    distance_multiplier: float = DISTANCE_MULTIPLIER,
) -> float:
    """Median nearest-neighbour gap within the cluster, scaled up — caps
    how far a single candidate link may reach without letting one large
    gap silently bridge two otherwise-separate stretches of manholes."""
    if len(cluster) < 2:
        return max_link_distance_m
    nearest_gaps: list[float] = []
    for m in cluster:
        others = [o for o in cluster if o.manhole_id != m.manhole_id]
        nearest = min(haversine_distance_m(m.lon, m.lat, o.lon, o.lat) for o in others)
        nearest_gaps.append(nearest)
    median_gap = _median(nearest_gaps)
    if median_gap <= 0:
        return max_link_distance_m
    return min(max_link_distance_m, median_gap * distance_multiplier)


# ---------------------------------------------------------------------------
# Phase 10/11 — optional supporting geometry (road corridor, buildings).
# Both are entirely optional: if the caller has no reliable geometry for
# this dataset, these checks are simply skipped (never fabricated).
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class SupportingGeometry:
    """Road LineStrings / building polygons already present in the SAME
    dataset (never external data), used only as an extra rejection check.
    Coordinates are [[lon, lat], ...] rings/lines in EPSG:4326."""
    road_lines: list[list[tuple[float, float]]] = field(default_factory=list)
    building_rings: list[list[tuple[float, float]]] = field(default_factory=list)


def _point_to_polyline_distance_m(point: tuple[float, float], line: list[tuple[float, float]]) -> float:
    lat_scale = 111_320.0
    lon_scale = 111_320.0 * math.cos(math.radians(point[1]))
    px, py = point[0] * lon_scale, point[1] * lat_scale
    best = math.inf
    for i in range(len(line) - 1):
        ax, ay = line[i][0] * lon_scale, line[i][1] * lat_scale
        bx, by = line[i + 1][0] * lon_scale, line[i + 1][1] * lat_scale
        t, perp = _point_segment_projection(px, py, ax, ay, bx, by)
        t_clamped = min(1.0, max(0.0, t))
        cx, cy = ax + t_clamped * (bx - ax), ay + t_clamped * (by - ay)
        dist = math.hypot(px - cx, py - cy)
        best = min(best, dist)
    return best if math.isfinite(best) else math.inf


def _exceeds_road_corridor(
    a: NormalizedManhole, b: NormalizedManhole,
    road_lines: list[list[tuple[float, float]]],
    max_offset_m: float = MAX_ROAD_CORRIDOR_OFFSET_M,
) -> bool:
    """True only when road geometry exists AND both endpoints sit farther
    than max_offset_m from every available road line — i.e. this candidate
    plainly does not follow any known road corridor."""
    if not road_lines:
        return False
    midpoint = ((a.lon + b.lon) / 2, (a.lat + b.lat) / 2)
    best = min(_point_to_polyline_distance_m(midpoint, line) for line in road_lines)
    return best > max_offset_m


def _segment_crosses_ring(p1: tuple[float, float], p2: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    """True if the open segment p1-p2 crosses the polygon boundary `ring`
    (a simple even-odd/orientation intersection test in lon/lat space —
    adequate at this feature's small-segment scale)."""
    def _ccw(o, a, b):
        return (b[1] - o[1]) * (a[0] - o[0]) > (a[1] - o[1]) * (b[0] - o[0])

    def _segments_intersect(a1, a2, b1, b2):
        return (_ccw(a1, b1, b2) != _ccw(a2, b1, b2)) and (_ccw(a1, a2, b1) != _ccw(a1, a2, b2))

    for i in range(len(ring) - 1):
        if _segments_intersect(p1, p2, ring[i], ring[i + 1]):
            return True
    return False


def _crosses_building(
    a: NormalizedManhole, b: NormalizedManhole,
    building_rings: list[list[tuple[float, float]]],
    tolerance_m: float = BUILDING_CROSSING_TOLERANCE_M,
) -> bool:
    if not building_rings:
        return False
    p1, p2 = (a.lon, a.lat), (b.lon, b.lat)
    for ring in building_rings:
        if len(ring) < 3:
            continue
        if _segment_crosses_ring(p1, p2, ring):
            # A grazing crossing exactly at a shared vertex/edge within
            # tolerance is not treated as "through the interior".
            mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
            if _point_to_polyline_distance_m(mid, ring) > tolerance_m:
                return True
    return False


# ---------------------------------------------------------------------------
# Phase 9 — crossing/intersection checks between accepted candidates.
# ---------------------------------------------------------------------------

def _segments_cross(
    a1: tuple[float, float], a2: tuple[float, float],
    b1: tuple[float, float], b2: tuple[float, float],
) -> bool:
    def _ccw(o, p, q):
        return (q[1] - o[1]) * (p[0] - o[0]) > (p[1] - o[1]) * (q[0] - o[0])
    return (_ccw(a1, b1, b2) != _ccw(a2, b1, b2)) and (_ccw(a1, a2, b1) != _ccw(a1, a2, b2))


def _candidate_strength(link: "_PendingCandidate") -> tuple[int, float, float]:
    """Higher is stronger. Ranked by: mutual-neighbour status, then better
    (smaller) alignment angle, then shorter distance — used both for
    node-degree pruning (Phase 8) and crossing arbitration (Phase 9)."""
    mutual_rank = {"mutual": 2, "sequential_one_sided": 1, "junction_candidate": 0}[link.neighbour_relationship]
    angle = link.alignment_angle_deg if link.alignment_angle_deg is not None else 0.0
    return (mutual_rank, -angle, -link.distance_m)


@dataclass(slots=True)
class _PendingCandidate:
    a: NormalizedManhole
    b: NormalizedManhole
    distance_m: float
    road_normalized: str
    road_cluster_id: str
    alignment_angle_deg: float | None
    alignment_status: str
    adaptive_max_distance_m: float
    neighbour_relationship: str = "sequential_one_sided"
    is_junction: bool = False


def build_candidate_links(
    manholes: list[NormalizedManhole],
    max_link_distance_m: float = MAX_LINK_DISTANCE_M,
    min_link_distance_m: float = MIN_LINK_DISTANCE_M,
    max_neighbours_per_manhole: int = MAX_NEIGHBOURS_PER_MANHOLE,
    supporting_geometry: SupportingGeometry | None = None,
    rejection_counts: dict[str, int] | None = None,
) -> list[CandidateLink]:
    """Phase 3-9 — strict staged candidate-connectivity rules.

    1. Group by normalized road name, then split each group into spatially
       connected clusters (Phase 3) so a reused road name never bridges
       two unrelated parts of town.
    2. Order each cluster along its local dominant axis and propose
       sequential-neighbour candidates (never a dense nearest-neighbour
       graph).
    3. Validate each candidate: local bearing alignment (Phase 4), no
       skipped intermediate manhole (Phase 5), adaptive local distance cap
       (Phase 6), optional road-corridor / building-crossing checks
       (Phase 10/11).
    4. Rank surviving candidates by mutual-neighbour preference (Phase 7)
       and resolve node-degree/junction limits (Phase 8) and unrelated
       crossings (Phase 9).
    """
    rejections = rejection_counts if rejection_counts is not None else {}

    def _reject(reason: str) -> None:
        rejections[reason] = rejections.get(reason, 0) + 1

    usable: list[NormalizedManhole] = []
    for m in manholes:
        has_geometry = m.geometry_valid and m.lon is not None and m.lat is not None
        if has_geometry and m.road_name_normalized:
            usable.append(m)
        elif not has_geometry:
            _reject("invalid_geometry")
        else:
            _reject("missing_road_name")

    by_road: dict[str, list[NormalizedManhole]] = {}
    for m in usable:
        by_road.setdefault(m.road_name_normalized, []).append(m)

    road_lines = (supporting_geometry.road_lines if supporting_geometry else []) or []
    building_rings = (supporting_geometry.building_rings if supporting_geometry else []) or []

    pending: list[_PendingCandidate] = []
    seen_pairs: set[tuple[str, str]] = set()

    for road, group in by_road.items():
        clusters = _split_into_clusters(group)
        for cluster_index, cluster in enumerate(clusters):
            cluster_id = _road_cluster_id(road, cluster_index)
            adaptive_max = _cluster_adaptive_max_distance(cluster, max_link_distance_m)
            ordered = _principal_axis_order(cluster)

            for i in range(len(ordered) - 1):
                a, b = ordered[i], ordered[i + 1]
                key = _pair_key(a.manhole_id, b.manhole_id)
                if key in seen_pairs:
                    _reject("duplicate_pair")
                    continue

                coord_key = (round(a.lon, 7), round(a.lat, 7))
                if (round(b.lon, 7), round(b.lat, 7)) == coord_key:
                    a.data_warnings.append(f"Duplicate coordinates with manhole {b.manhole_id} — link skipped.")
                    b.data_warnings.append(f"Duplicate coordinates with manhole {a.manhole_id} — link skipped.")
                    _reject("duplicate_coordinate")
                    continue

                distance = haversine_distance_m(a.lon, a.lat, b.lon, b.lat)
                if distance < min_link_distance_m:
                    _reject("below_min_distance")
                    continue
                if distance > max_link_distance_m:
                    _reject("exceeds_hard_max_distance")
                    continue
                if distance > adaptive_max:
                    _reject("exceeds_adaptive_distance")
                    continue

                if _skips_intermediate_manhole(a, b, cluster):
                    _reject("skips_intermediate_manhole")
                    continue

                passes_alignment, angle_diff, alignment_status = _check_alignment(a, b, cluster)
                if not passes_alignment:
                    _reject("poor_local_alignment")
                    continue

                if _exceeds_road_corridor(a, b, road_lines):
                    _reject("deviates_from_road_corridor")
                    continue
                if _crosses_building(a, b, building_rings):
                    _reject("crosses_building_polygon")
                    continue

                seen_pairs.add(key)
                pending.append(_PendingCandidate(
                    a=a, b=b, distance_m=distance, road_normalized=road, road_cluster_id=cluster_id,
                    alignment_angle_deg=angle_diff, alignment_status=alignment_status,
                    adaptive_max_distance_m=adaptive_max,
                ))

    # --- Phase 7: mutual-neighbour preference -----------------------------
    # A candidate is "mutual" when each endpoint's nearest surviving
    # candidate (by distance) on this list is the other endpoint.
    by_manhole: dict[str, list[_PendingCandidate]] = {}
    for cand in pending:
        by_manhole.setdefault(cand.a.manhole_id, []).append(cand)
        by_manhole.setdefault(cand.b.manhole_id, []).append(cand)

    def _nearest_partner(manhole_id: str) -> str | None:
        options = by_manhole.get(manhole_id, [])
        if not options:
            return None
        best = min(options, key=lambda c: c.distance_m)
        return best.b.manhole_id if best.a.manhole_id == manhole_id else best.a.manhole_id

    for cand in pending:
        a_nearest = _nearest_partner(cand.a.manhole_id)
        b_nearest = _nearest_partner(cand.b.manhole_id)
        if a_nearest == cand.b.manhole_id and b_nearest == cand.a.manhole_id:
            cand.neighbour_relationship = "mutual"
        else:
            cand.neighbour_relationship = "sequential_one_sided"

    # --- Phase 8: node-degree / junction control ---------------------------
    accepted: list[_PendingCandidate] = []
    degree: dict[str, int] = {m.manhole_id: 0 for m in usable}

    # Rank all candidates strongest-first so degree limits keep the best
    # links regardless of iteration order.
    for cand in sorted(pending, key=_candidate_strength, reverse=True):
        a_id, b_id = cand.a.manhole_id, cand.b.manhole_id
        limit_a = max_neighbours_per_manhole
        limit_b = max_neighbours_per_manhole

        # Allow a third link only when it forms a genuine junction: the
        # existing accepted links at that node have branch bearings clearly
        # distinct from this candidate's bearing (Phase 8 conditions 1-4).
        for node_id, other_id in ((a_id, b_id), (b_id, a_id)):
            if degree[node_id] < max_neighbours_per_manhole:
                continue
            existing_bearings = [
                _bearing_deg(cand.a if c.a.manhole_id == node_id else c.b, c.b if c.a.manhole_id == node_id else c.a)
                for c in accepted
                if node_id in (c.a.manhole_id, c.b.manhole_id)
            ]
            this_bearing = _bearing_deg(cand.a, cand.b) if node_id == a_id else _bearing_deg(cand.b, cand.a)
            distinct_branches = all(
                _angle_difference_deg(this_bearing, eb) >= MIN_JUNCTION_BRANCH_SEPARATION_DEG
                for eb in existing_bearings
            )
            not_skipping = not _skips_intermediate_manhole(cand.a, cand.b, [cand.a, cand.b])
            if distinct_branches and not_skipping and degree[node_id] < MAX_JUNCTION_NEIGHBOURS_PER_MANHOLE:
                cand.is_junction = True
                cand.neighbour_relationship = "junction_candidate"
                if node_id == a_id:
                    limit_a = MAX_JUNCTION_NEIGHBOURS_PER_MANHOLE
                else:
                    limit_b = MAX_JUNCTION_NEIGHBOURS_PER_MANHOLE
            else:
                if node_id == a_id:
                    limit_a = max_neighbours_per_manhole
                else:
                    limit_b = max_neighbours_per_manhole

        if degree[a_id] >= limit_a or degree[b_id] >= limit_b:
            _reject("node_degree_limit")
            continue

        # --- Phase 9: reject if this candidate crosses an already-accepted
        # candidate without sharing an endpoint or a valid junction node.
        p1, p2 = (cand.a.lon, cand.a.lat), (cand.b.lon, cand.b.lat)
        crossed = False
        for other in accepted:
            shares_endpoint = {a_id, b_id} & {other.a.manhole_id, other.b.manhole_id}
            if shares_endpoint:
                continue
            q1, q2 = (other.a.lon, other.a.lat), (other.b.lon, other.b.lat)
            if _segments_cross(p1, p2, q1, q2):
                crossed = True
                break
        if crossed:
            _reject("crosses_unrelated_candidate")
            continue

        accepted.append(cand)
        degree[a_id] += 1
        degree[b_id] += 1

    return [
        CandidateLink(
            manhole_a=c.a, manhole_b=c.b, distance_m=c.distance_m,
            road_name_normalized=c.road_normalized, road_cluster_id=c.road_cluster_id,
            alignment_angle_deg=c.alignment_angle_deg, alignment_status=c.alignment_status,
            adaptive_max_distance_m=c.adaptive_max_distance_m,
            neighbour_relationship=c.neighbour_relationship, is_junction=c.is_junction,
        )
        for c in accepted
    ]


# ---------------------------------------------------------------------------
# Phase 9/10 — direction + confidence classification
# ---------------------------------------------------------------------------

DirectionStatus = Literal["confirmed", "estimated", "flat_or_uncertain", "unknown", "conflict"]
ArrowStyle = Literal["closed", "open", "none"]


@dataclass(slots=True)
class FlowSegment:
    segment_id: str
    dataset_id: str
    upstream: NormalizedManhole
    downstream: NormalizedManhole
    road_name_raw: str | None
    distance_m: float

    direction_status: DirectionStatus
    direction_source: str
    arrow_style: ArrowStyle
    confidence: str

    elevation_difference_m: float | None
    slope_ratio: float | None
    slope_percent: float | None
    data_warning: str | None
    road_cluster_id: str = ""


def _slope(upstream_invert_m: float, downstream_invert_m: float, length_m: float) -> tuple[float, float] | None:
    if length_m <= 0:
        return None
    ratio = (upstream_invert_m - downstream_invert_m) / length_m
    return ratio, ratio * 100


def classify_segment(link: CandidateLink) -> FlowSegment:
    seg = _classify_segment_raw(link)
    seg.road_cluster_id = link.road_cluster_id
    return seg


def _classify_segment_raw(link: CandidateLink) -> FlowSegment:
    a, b = link.manhole_a, link.manhole_b
    road_raw = a.road_name_raw or b.road_name_raw
    segment_id = f"FLOW-{a.manhole_id}-{b.manhole_id}"

    a_conflict = a.elevation_validation == "conflict"
    b_conflict = b.elevation_validation == "conflict"
    if a_conflict or b_conflict:
        return FlowSegment(
            segment_id=segment_id, dataset_id=a.dataset_id, upstream=a, downstream=b,
            road_name_raw=road_raw, distance_m=link.distance_m,
            direction_status="conflict", direction_source="data_conflict",
            arrow_style="none", confidence="none",
            elevation_difference_m=None, slope_ratio=None, slope_percent=None,
            data_warning="Elevation data conflict at one or both manholes — direction not shown.",
        )

    invert_a, invert_b = a.usable_invert_m, b.usable_invert_m

    if invert_a is None or invert_b is None:
        # Phase 10-C: controlled neighbouring-trend estimation is performed
        # by classify_with_trend() at the network level, which has visibility
        # into the whole road sequence. A single pairwise call cannot safely
        # infer a trend from one link — see build_flow_geojson().
        return FlowSegment(
            segment_id=segment_id, dataset_id=a.dataset_id, upstream=a, downstream=b,
            road_name_raw=road_raw, distance_m=link.distance_m,
            direction_status="unknown", direction_source="insufficient_data",
            arrow_style="none", confidence="none",
            elevation_difference_m=None, slope_ratio=None, slope_percent=None,
            data_warning=None,
        )

    diff = invert_a - invert_b
    if abs(diff) <= MIN_DIRECTION_DIFFERENCE_M:
        return FlowSegment(
            segment_id=segment_id, dataset_id=a.dataset_id, upstream=a, downstream=b,
            road_name_raw=road_raw, distance_m=link.distance_m,
            direction_status="flat_or_uncertain", direction_source="insufficient_data",
            arrow_style="none", confidence="none",
            elevation_difference_m=diff, slope_ratio=None, slope_percent=None,
            data_warning="Elevation difference within tolerance — direction not reliable.",
        )

    upstream, downstream = (a, b) if diff > 0 else (b, a)
    upstream_invert, downstream_invert = max(invert_a, invert_b), min(invert_a, invert_b)
    slope = _slope(upstream_invert, downstream_invert, link.distance_m)
    slope_ratio, slope_percent = slope if slope else (None, None)

    warning = None
    if slope_percent is not None:
        if slope_percent < MIN_SLOPE_PERCENT_WARNING:
            warning = f"Slope {slope_percent:.3f}% is unusually flat — data-quality flag, not a direction override."
        elif slope_percent > MAX_SLOPE_PERCENT_WARNING:
            warning = f"Slope {slope_percent:.3f}% is unusually steep — data-quality flag, not a direction override."

    both_direct = upstream.invert_source == "direct_bottom" and downstream.invert_source == "direct_bottom"
    both_no_conflict = (
        upstream.elevation_validation != "conflict" and downstream.elevation_validation != "conflict"
    )

    if both_direct and both_no_conflict:
        return FlowSegment(
            segment_id=segment_id, dataset_id=a.dataset_id, upstream=upstream, downstream=downstream,
            road_name_raw=road_raw, distance_m=link.distance_m,
            direction_status="confirmed", direction_source="direct_bottom_levels",
            arrow_style="closed", confidence="high",
            elevation_difference_m=abs(diff), slope_ratio=slope_ratio, slope_percent=slope_percent,
            data_warning=warning,
        )

    one_derived = upstream.invert_source == "top_minus_depth" or downstream.invert_source == "top_minus_depth"
    both_derived = upstream.invert_source == "top_minus_depth" and downstream.invert_source == "top_minus_depth"
    if one_derived and both_no_conflict:
        source = "both_derived_inverts" if both_derived else "one_derived_invert"
        return FlowSegment(
            segment_id=segment_id, dataset_id=a.dataset_id, upstream=upstream, downstream=downstream,
            road_name_raw=road_raw, distance_m=link.distance_m,
            direction_status="estimated", direction_source=source,
            arrow_style="open", confidence="derived",
            elevation_difference_m=abs(diff), slope_ratio=slope_ratio, slope_percent=slope_percent,
            data_warning=warning,
        )

    # Elevation-validation "warning" state (not conflict) on a direct pair —
    # still real elevation evidence, but downgraded from "confirmed" per
    # Phase 6 ("Downgrade any affected segment to estimated").
    return FlowSegment(
        segment_id=segment_id, dataset_id=a.dataset_id, upstream=upstream, downstream=downstream,
        road_name_raw=road_raw, distance_m=link.distance_m,
        direction_status="estimated", direction_source="one_derived_invert",
        arrow_style="open", confidence="derived",
        elevation_difference_m=abs(diff), slope_ratio=slope_ratio, slope_percent=slope_percent,
        data_warning=warning or "Elevation validation warning on one endpoint — downgraded from confirmed.",
    )


# ---------------------------------------------------------------------------
# Phase 10-C — controlled neighbouring-trend estimation
# ---------------------------------------------------------------------------

def apply_neighbouring_trend(
    segments: list[FlowSegment],
    unknown_links: list[CandidateLink],
    all_manholes_by_road: dict[str, list[NormalizedManhole]] | None = None,
) -> list[FlowSegment]:
    """For candidate links with no usable invert at one/both ends, allow a
    low-confidence estimate ONLY when the same road has at least two OTHER
    manholes (distinct from this link's own endpoints) with known invert
    values that agree on a single consistent monotonic direction along the
    road. A single known neighbour is never sufficient (Phase 10-C rule 6).
    Returns replacement FlowSegments for `unknown_links`.
    """
    all_manholes_by_road = all_manholes_by_road or {}

    results: list[FlowSegment] = []
    for link in unknown_links:
        a, b = link.manhole_a, link.manhole_b
        road = link.road_name_normalized
        road_group = all_manholes_by_road.get(road, [])

        # Evidence = other manholes on this road (not this link's own
        # endpoints) that have a usable invert — need at least two so a
        # monotonic trend can be established rather than assumed from one.
        evidence = [
            m for m in road_group
            if m.usable_invert_m is not None and m.manhole_id not in (a.manhole_id, b.manhole_id)
        ]
        if len(evidence) < 2:
            continue  # not enough independent evidence — stays "unknown"

        axis = _dominant_axis(road_group)
        ordered_evidence = sorted(evidence, key=lambda m: _axis_value(m, axis))
        inverts = [m.usable_invert_m for m in ordered_evidence]
        # Consistent monotonic trend: invert must move strictly the same
        # direction as the axis value across all evidence points.
        diffs = [inverts[i + 1] - inverts[i] for i in range(len(inverts) - 1)]
        if not diffs or not (all(d < 0 for d in diffs) or all(d > 0 for d in diffs)):
            continue  # flat or contradictory trend — cannot responsibly estimate
        # True when invert decreases as axis value increases — in that case
        # the LOWER-axis point has the HIGHER invert, i.e. is upstream.
        invert_decreases_with_axis = diffs[0] < 0

        a_axis, b_axis = _axis_value(a, axis), _axis_value(b, axis)
        if a_axis == b_axis:
            continue
        a_is_higher_axis = a_axis > b_axis
        # invert_decreases_with_axis=True  -> lower axis is upstream -> a upstream iff NOT a_is_higher_axis
        # invert_decreases_with_axis=False -> higher axis is upstream -> a upstream iff a_is_higher_axis
        a_is_upstream = (not a_is_higher_axis) if invert_decreases_with_axis else a_is_higher_axis
        upstream, downstream = (a, b) if a_is_upstream else (b, a)

        # No contradictory known invert at either endpoint of this specific link.
        if upstream.usable_invert_m is not None and downstream.usable_invert_m is not None:
            if upstream.usable_invert_m <= downstream.usable_invert_m:
                continue  # known inverts actually disagree with the trend — do not override

        results.append(FlowSegment(
            segment_id=f"FLOW-{a.manhole_id}-{b.manhole_id}",
            dataset_id=a.dataset_id, upstream=upstream, downstream=downstream,
            road_name_raw=a.road_name_raw or b.road_name_raw, distance_m=link.distance_m,
            direction_status="estimated", direction_source="neighbouring_road_trend",
            arrow_style="open", confidence="low",
            elevation_difference_m=None, slope_ratio=None, slope_percent=None,
            data_warning="Direction estimated from neighbouring road trend, not this segment's own elevation data.",
            road_cluster_id=link.road_cluster_id,
        ))
    return results


# ---------------------------------------------------------------------------
# Phase 12 — GeoJSON assembly
# ---------------------------------------------------------------------------

DISCLAIMER = (
    "Flow directions are inferred from available manhole attributes and spatial "
    "relationships. Actual underground connectivity must be verified against UGD "
    "pipe survey or as-built data."
)
CLOSED_ARROW_MEANING = (
    "Closed arrows confirm elevation-based direction for an inferred connection. "
    "They do not confirm surveyed underground pipe connectivity."
)

# Phase 13/18 wording — never implies surveyed/verified physical
# connectivity. "confirmed" stays the internal direction_status value
# (changing it would ripple into filters/tests/frontend keys for no
# benefit); only user-facing text changes.
DIRECTION_STATUS_DISPLAY_LABEL: dict[str, str] = {
    "confirmed": "Direction supported by direct levels",
    "estimated": "Estimated / derived",
    "flat_or_uncertain": "Direction unknown",
    "unknown": "Direction unknown",
    "conflict": "Data conflict",
}

_DIRECTION_EVIDENCE_BY_STATUS_AND_SOURCE: dict[tuple[str, str], str] = {
    ("confirmed", "direct_bottom_levels"): "Direct bottom/invert levels at both endpoints",
    ("estimated", "one_derived_invert"): "Top level minus normalized depth used at one or both endpoints",
    ("estimated", "both_derived_inverts"): "Top level minus normalized depth used at one or both endpoints",
    ("estimated", "neighbouring_road_trend"): "Consistent neighbouring same-road elevation trend",
    ("unknown", "insufficient_data"): "Insufficient elevation information",
    ("flat_or_uncertain", "insufficient_data"): "Insufficient elevation information",
    ("conflict", "data_conflict"): "Conflicting or invalid elevation information",
}


def _direction_evidence(direction_status: str, direction_source: str) -> str:
    return _DIRECTION_EVIDENCE_BY_STATUS_AND_SOURCE.get(
        (direction_status, direction_source), "Insufficient elevation information"
    )


def _round_or_none(value: float | None, digits: int) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def segment_to_feature(seg: FlowSegment) -> dict[str, Any]:
    up, down = seg.upstream, seg.downstream
    return {
        "type": "Feature",
        "id": seg.segment_id.lower(),
        "geometry": {
            "type": "LineString",
            "coordinates": [[up.lon, up.lat], [down.lon, down.lat]],
        },
        "properties": {
            "segment_id": seg.segment_id,
            "candidate_connection": True,
            "connectivity_status": "spatially_inferred",
            "dataset_id": seg.dataset_id,
            "road_cluster_id": seg.road_cluster_id or None,
            "from_manhole": up.display_id,
            "to_manhole": down.display_id,
            "upstream_manhole": up.display_id,
            "downstream_manhole": down.display_id,
            "road_name": seg.road_name_raw,
            "upstream_invert_m": _round_or_none(up.usable_invert_m, 3),
            "downstream_invert_m": _round_or_none(down.usable_invert_m, 3),
            "elevation_difference_m": _round_or_none(seg.elevation_difference_m, 3),
            "length_m": _round_or_none(seg.distance_m, 2),
            "slope_ratio": _round_or_none(seg.slope_ratio, 5),
            "slope_percent": _round_or_none(seg.slope_percent, 3),
            "direction_status": seg.direction_status,
            "direction_status_label": DIRECTION_STATUS_DISPLAY_LABEL.get(seg.direction_status, seg.direction_status),
            "direction_source": seg.direction_source,
            "direction_evidence": _direction_evidence(seg.direction_status, seg.direction_source),
            "arrow_style": seg.arrow_style,
            "confidence": seg.confidence,
            "upstream_invert_source": up.invert_source,
            "downstream_invert_source": down.invert_source,
            "upstream_elevation_validation": up.elevation_validation,
            "downstream_elevation_validation": down.elevation_validation,
            "data_warning": seg.data_warning,
            "disclaimer": DISCLAIMER,
            "closed_arrow_meaning": CLOSED_ARROW_MEANING,
        },
    }


@dataclass(slots=True)
class FlowAnalyticsSummary:
    total_manholes: int
    candidate_connections: int
    confirmed_segments: int
    derived_segments: int
    estimated_trend_segments: int
    unknown_segments: int
    conflict_segments: int
    manholes_with_direct_invert: int
    manholes_with_derived_invert: int
    manholes_missing_invert: int

    def as_dict(self) -> dict[str, int]:
        return {
            "total_manholes": self.total_manholes,
            "candidate_connections": self.candidate_connections,
            "confirmed_segments": self.confirmed_segments,
            "derived_segments": self.derived_segments,
            "estimated_trend_segments": self.estimated_trend_segments,
            "unknown_segments": self.unknown_segments,
            "conflict_segments": self.conflict_segments,
            "manholes_with_direct_invert": self.manholes_with_direct_invert,
            "manholes_with_derived_invert": self.manholes_with_derived_invert,
            "manholes_missing_invert": self.manholes_missing_invert,
        }


def build_flow_network(
    manholes: list[NormalizedManhole],
    max_link_distance_m: float = MAX_LINK_DISTANCE_M,
    supporting_geometry: SupportingGeometry | None = None,
    rejection_counts: dict[str, int] | None = None,
) -> tuple[list[FlowSegment], FlowAnalyticsSummary]:
    """Full Phase 3-10 pipeline: candidate links (spatially clustered,
    alignment/intermediate/adaptive-distance validated) -> direct
    classification -> controlled neighbouring-trend pass for the remainder."""
    links = build_candidate_links(
        manholes, max_link_distance_m=max_link_distance_m,
        supporting_geometry=supporting_geometry, rejection_counts=rejection_counts,
    )

    usable = [
        m for m in manholes
        if m.geometry_valid and m.lon is not None and m.lat is not None and m.road_name_normalized
    ]
    by_road: dict[str, list[NormalizedManhole]] = {}
    for m in usable:
        by_road.setdefault(m.road_name_normalized, []).append(m)

    direct_segments: list[FlowSegment] = []
    unknown_links: list[CandidateLink] = []
    for link in links:
        seg = classify_segment(link)
        if seg.direction_status == "unknown":
            unknown_links.append(link)
        direct_segments.append(seg)

    trend_segments = apply_neighbouring_trend(direct_segments, unknown_links, by_road)
    trend_pairs = {(s.upstream.manhole_id, s.downstream.manhole_id) for s in trend_segments}
    trend_pairs |= {(d, u) for u, d in trend_pairs}

    final_segments = [
        seg for seg in direct_segments
        if not (seg.direction_status == "unknown" and (seg.upstream.manhole_id, seg.downstream.manhole_id) in trend_pairs)
    ]
    final_segments.extend(trend_segments)

    summary = FlowAnalyticsSummary(
        total_manholes=len(manholes),
        candidate_connections=len(final_segments),
        confirmed_segments=sum(1 for s in final_segments if s.direction_status == "confirmed"),
        derived_segments=sum(
            1 for s in final_segments
            if s.direction_status == "estimated" and s.direction_source != "neighbouring_road_trend"
        ),
        estimated_trend_segments=sum(
            1 for s in final_segments
            if s.direction_source == "neighbouring_road_trend"
        ),
        unknown_segments=sum(1 for s in final_segments if s.direction_status in ("unknown", "flat_or_uncertain")),
        conflict_segments=sum(1 for s in final_segments if s.direction_status == "conflict"),
        manholes_with_direct_invert=sum(1 for m in manholes if m.invert_source == "direct_bottom"),
        manholes_with_derived_invert=sum(1 for m in manholes if m.invert_source == "top_minus_depth"),
        manholes_missing_invert=sum(1 for m in manholes if m.invert_source == "missing"),
    )
    return final_segments, summary


def build_flow_geojson(
    manholes: list[NormalizedManhole],
    max_link_distance_m: float = MAX_LINK_DISTANCE_M,
    include_unknown: bool = True,
    direction_status_filter: set[str] | None = None,
    supporting_geometry: SupportingGeometry | None = None,
) -> dict[str, Any]:
    rejection_counts: dict[str, int] = {}
    segments, summary = build_flow_network(
        manholes, max_link_distance_m=max_link_distance_m,
        supporting_geometry=supporting_geometry, rejection_counts=rejection_counts,
    )

    filtered = segments
    if not include_unknown:
        filtered = [s for s in filtered if s.direction_status not in ("unknown", "flat_or_uncertain")]
    if direction_status_filter:
        filtered = [s for s in filtered if s.direction_status in direction_status_filter]

    return {
        "type": "FeatureCollection",
        "features": [segment_to_feature(s) for s in filtered],
        "summary": summary.as_dict(),
        "candidate_rejections": rejection_counts,
        "disclaimer": DISCLAIMER,
        "closed_arrow_meaning": CLOSED_ARROW_MEANING,
        "config": {
            "default_depth_unit": DEFAULT_DEPTH_UNIT,
            "max_link_distance_m": max_link_distance_m,
            "min_link_distance_m": MIN_LINK_DISTANCE_M,
            "max_neighbours_per_manhole": MAX_NEIGHBOURS_PER_MANHOLE,
            "depth_match_tolerance_m": DEPTH_MATCH_TOLERANCE_M,
            "depth_warning_tolerance_m": DEPTH_WARNING_TOLERANCE_M,
            "min_direction_difference_m": MIN_DIRECTION_DIFFERENCE_M,
            "cluster_link_distance_m": CLUSTER_LINK_DISTANCE_M,
            "max_alignment_angle_deg": MAX_ALIGNMENT_ANGLE_DEG,
            "distance_multiplier": DISTANCE_MULTIPLIER,
        },
    }

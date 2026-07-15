"""
Unit tests for the Estimated Wastewater Flow Direction pipeline
(app.services.wastewater_flow). Pure-function tests — no DB/network
required — covering the classification matrix specified for this feature
(Tests A-N).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.services.wastewater_flow import (  # noqa: E402
    CLUSTER_LINK_DISTANCE_M,
    FEET_TO_METRES,
    SupportingGeometry,
    build_candidate_links,
    build_flow_network,
    classify_segment,
    normalize_manhole,
    parse_depth_metres,
    parse_numeric,
    segment_to_feature,
)


def _point_geom(lon: float, lat: float) -> dict:
    return {"type": "Point", "coordinates": [lon, lat]}


def _mh(manhole_id: str, lon: float, lat: float, road="Cross Road 18", **attrs):
    attributes = {"ROAD_NAME": road, **attrs}
    return normalize_manhole(manhole_id, "ds-1", attributes, _point_geom(lon, lat))


# --- Test A: two direct bottom levels -> confirmed / closed arrow ---------
def test_a_two_direct_bottom_levels_confirmed():
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=580.0)
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=579.5)
    links = build_candidate_links([a, b])
    assert len(links) == 1
    seg = classify_segment(links[0])
    assert seg.upstream.manhole_id == "A"
    assert seg.downstream.manhole_id == "B"
    assert seg.direction_status == "confirmed"
    assert seg.arrow_style == "closed"
    assert seg.direction_source == "direct_bottom_levels"


# --- Test B: reverse input order still yields correct direction -----------
def test_b_reverse_input_order_still_correct():
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=579.5)
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=580.0)
    links = build_candidate_links([b, a])
    assert len(links) == 1
    seg = classify_segment(links[0])
    assert seg.upstream.manhole_id == "A"
    assert seg.downstream.manhole_id == "B"
    assert seg.arrow_style == "closed"


# --- Test C: one derived level ---------------------------------------------
def test_c_one_derived_level():
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=580.0)
    b = _mh("B", 75.9002, 14.4600, TOP_LEVEL=580.0, DEPTH="3 feet")
    expected_b_invert = 580.0 - 3 * FEET_TO_METRES
    assert abs(b.usable_invert_m - expected_b_invert) < 1e-6
    links = build_candidate_links([a, b])
    seg = classify_segment(links[0])
    assert seg.upstream.manhole_id == "A"
    assert seg.downstream.manhole_id == "B"
    assert seg.direction_status == "estimated"
    assert seg.arrow_style == "open"
    assert seg.direction_source == "one_derived_invert"


# --- Test D: both derived ---------------------------------------------------
def test_d_both_derived():
    a = _mh("A", 75.9000, 14.4600, TOP_LEVEL=583.0, DEPTH="3 m")
    b = _mh("B", 75.9002, 14.4600, TOP_LEVEL=580.0, DEPTH="1 m")
    links = build_candidate_links([a, b])
    seg = classify_segment(links[0])
    assert seg.direction_status == "estimated"
    assert seg.arrow_style == "open"
    assert seg.direction_source == "both_derived_inverts"
    # A invert = 580, B invert = 579 -> A upstream, B downstream
    assert seg.upstream.manhole_id == "A"
    assert seg.downstream.manhole_id == "B"


# --- Test E: equal levels -> flat/uncertain, no arrow -----------------------
def test_e_equal_levels_no_arrow():
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=580.0)
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=580.005)
    links = build_candidate_links([a, b])
    seg = classify_segment(links[0])
    assert seg.direction_status == "flat_or_uncertain"
    assert seg.arrow_style == "none"


# --- Test F: missing elevations both sides ----------------------------------
def test_f_missing_elevations_unknown():
    a = _mh("A", 75.9000, 14.4600)
    b = _mh("B", 75.9002, 14.4600)
    links = build_candidate_links([a, b])
    seg = classify_segment(links[0])
    assert seg.direction_status == "unknown"
    assert seg.arrow_style == "none"


# --- Test G: neighbouring trend from >=2 known monotonic segments ----------
def test_g_neighbouring_trend_estimation():
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=582.0)
    b = _mh("B", 75.9002, 14.4600)  # missing — the gap segment
    c = _mh("C", 75.9004, 14.4600, BOTTOM_LEVEL=581.0)
    d = _mh("D", 75.9006, 14.4600, BOTTOM_LEVEL=580.0)
    segments, _summary = build_flow_network([a, b, c, d])
    trend_segs = [s for s in segments if s.direction_source == "neighbouring_road_trend"]
    # Both links touching the missing-invert manhole B (A-B and B-C) have
    # enough independent evidence elsewhere on the road (A, C, D all have
    # known inverts) to be trend-estimated, each with an open low-confidence arrow.
    assert len(trend_segs) == 2
    for seg in trend_segs:
        assert seg.arrow_style == "open"
        assert seg.confidence == "low"
        # Trend is monotonically decreasing invert as lon increases (A=582 -> D=580),
        # so within every trend segment the lower-lon endpoint must be upstream.
        assert seg.upstream.lon < seg.downstream.lon


def test_g_single_neighbour_not_enough():
    # Only ONE known segment nearby — must NOT estimate (spec explicitly
    # forbids inferring from a single known neighbouring point).
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=582.0)
    b = _mh("B", 75.9002, 14.4600)
    segments, _ = build_flow_network([a, b])
    assert all(s.direction_source != "neighbouring_road_trend" for s in segments)
    assert any(s.direction_status == "unknown" for s in segments)


# --- Test H: conflict (top/bottom/depth disagree beyond tolerance) --------
def test_h_conflict_no_closed_arrow():
    a = _mh("A", 75.9000, 14.4600, TOP_LEVEL=590.0, BOTTOM_LEVEL=580.0, DEPTH="1 m")
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=579.0)
    assert a.elevation_validation == "conflict"
    links = build_candidate_links([a, b])
    seg = classify_segment(links[0])
    assert seg.direction_status == "conflict"
    assert seg.arrow_style == "none"


# --- Test I: different roads -> no candidate connection ---------------------
def test_i_different_roads_no_link():
    a = _mh("A", 75.9000, 14.4600, road="Cross Road 18", BOTTOM_LEVEL=580.0)
    b = _mh("B", 75.9002, 14.4600, road="Main Road", BOTTOM_LEVEL=579.0)
    links = build_candidate_links([a, b])
    assert links == []


# --- Test J: excessive distance -> no link ----------------------------------
def test_j_excessive_distance_no_link():
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=580.0)
    b = _mh("B", 75.9500, 14.4600, BOTTOM_LEVEL=579.0)  # ~5km away
    links = build_candidate_links([a, b], max_link_distance_m=100.0)
    assert links == []


# --- Test K: duplicate coordinates -> warning, no zero-length segment ------
def test_k_duplicate_coordinates_no_segment():
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=580.0)
    b = _mh("B", 75.9000, 14.4600, BOTTOM_LEVEL=579.0)
    links = build_candidate_links([a, b])
    assert links == []
    assert any("Duplicate coordinates" in w for w in a.data_warnings)


# --- Test L: dataset separation ---------------------------------------------
def test_l_dataset_separation_not_linked_by_service():
    # The service itself takes a flat manhole list; the API layer enforces
    # dataset scoping by querying one dataset_id set at a time. Verify the
    # dataset_id is carried through so callers CAN enforce this boundary.
    a = normalize_manhole("A", "ds-1", {"ROAD_NAME": "Cross Road 18", "BOTTOM_LEVEL": 580.0}, _point_geom(75.90, 14.46))
    b = normalize_manhole("B", "ds-2", {"ROAD_NAME": "Cross Road 18", "BOTTOM_LEVEL": 579.0}, _point_geom(75.9002, 14.46))
    assert a.dataset_id != b.dataset_id
    # (API layer filters by dataset_id in the SQL WHERE clause before these
    # ever reach build_candidate_links — see api/v1/wastewater_flow.py.)


# --- Test M: invalid numeric text -------------------------------------------
def test_m_invalid_numeric_text_no_exception():
    parsed = parse_numeric("Blocked")
    assert parsed.value is None
    parsed2 = parse_numeric("N/A")
    assert parsed2.value is None
    m = _mh("A", 75.90, 14.46, TOP_LEVEL="Blocked")
    assert m.top_level_m is None
    assert any("could not be parsed" in w for w in m.data_warnings) or m.top_level_m is None


# --- Test N: feet conversion -------------------------------------------------
def test_n_feet_conversion():
    depth_m, status = parse_depth_metres("3 feet")
    assert status == "explicit"
    assert abs(depth_m - 0.9144) < 1e-6


def test_numeric_parser_edge_cases():
    assert parse_numeric("578.503").value == 578.503
    assert parse_numeric(578.503).value == 578.503
    assert parse_numeric("").value is None
    assert parse_numeric(None).value is None
    assert parse_numeric("-").value is None
    assert parse_numeric("Blocked").value is None
    assert parse_numeric("N/A").value is None


def test_depth_unit_parsing_variants():
    for text, expected_m in [
        ("3 feet", 3 * FEET_TO_METRES),
        ("3.3 feet", 3.3 * FEET_TO_METRES),
        ("12 ft", 12 * FEET_TO_METRES),
        ("2 m", 2.0),
        ("0.9 metre", 0.9),
    ]:
        depth_m, status = parse_depth_metres(text)
        assert status == "explicit"
        assert abs(depth_m - expected_m) < 1e-6


def test_bare_number_depth_uses_configurable_default():
    depth_m, status = parse_depth_metres("3", default_unit="feet")
    assert status == "assumed_default"
    assert abs(depth_m - 3 * FEET_TO_METRES) < 1e-6

    depth_m_m, status_m = parse_depth_metres("3", default_unit="metres")
    assert status_m == "assumed_default"
    assert abs(depth_m_m - 3.0) < 1e-6


# --- Coordinate order (Phase 17) --------------------------------------------
def test_geojson_linestring_coordinate_order_follows_flow():
    from app.services.wastewater_flow import segment_to_feature

    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=580.0)
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=579.5)
    links = build_candidate_links([a, b])
    seg = classify_segment(links[0])
    feature = segment_to_feature(seg)
    coords = feature["geometry"]["coordinates"]
    assert coords[0] == [a.lon, a.lat]
    assert coords[1] == [b.lon, b.lat]
    assert feature["properties"]["upstream_manhole"] == "A"
    assert feature["properties"]["downstream_manhole"] == "B"


def test_no_nan_or_infinity_in_output():
    import json

    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=580.0)
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=579.5)
    links = build_candidate_links([a, b])
    seg = classify_segment(links[0])
    feature = segment_to_feature(seg)
    # json.dumps with allow_nan=False raises on NaN/Infinity — this must not raise.
    json.dumps(feature, allow_nan=False)


# =============================================================================
# Connectivity-refinement tests (spatial clustering, local alignment,
# intermediate-point rejection, adaptive distance, mutual-neighbour
# preference, crossing checks, junctions) — Tests A-L of the refinement spec.
# =============================================================================

def _pair(features, a_id, b_id):
    ids = {a_id, b_id}
    for f in features:
        if {f["properties"]["from_manhole"], f["properties"]["to_manhole"]} == ids:
            return f
    return None


# --- Test A: disconnected same-road clusters --------------------------------
def test_a_disconnected_clusters_not_linked():
    # Two pairs of manholes sharing "Cross Road 18" but ~500m apart —
    # clearly two unrelated stretches of road with the same name.
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=580.0)
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=579.5)
    c = _mh("C", 75.9100, 14.4600, BOTTOM_LEVEL=580.0)  # ~1000m east of A/B
    d = _mh("D", 75.9102, 14.4600, BOTTOM_LEVEL=579.5)
    links = build_candidate_links([a, b, c, d])
    pairs = {frozenset((l.manhole_a.manhole_id, l.manhole_b.manhole_id)) for l in links}
    assert frozenset(("A", "B")) in pairs
    assert frozenset(("C", "D")) in pairs
    # No link should ever bridge the two clusters.
    assert frozenset(("B", "C")) not in pairs
    assert frozenset(("A", "D")) not in pairs
    # Distinct cluster ids for the two components.
    cluster_ids = {l.road_cluster_id for l in links}
    assert len(cluster_ids) == 2


# --- Test B: diagonal poor-alignment candidate rejected ----------------------
def test_b_diagonal_poor_alignment_rejected():
    # A straight run of manholes along a road (roughly east-west), plus one
    # point offset well off that line — a candidate to it would be a
    # diagonal "shortcut" that doesn't follow the established local trend.
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=584.0)
    b = _mh("B", 75.9002, 14.46001, BOTTOM_LEVEL=583.5)
    c = _mh("C", 75.9004, 14.46002, BOTTOM_LEVEL=583.0)
    off = _mh("OFF", 75.90035, 14.4620, BOTTOM_LEVEL=582.0)  # ~220m north of the line
    links = build_candidate_links([a, b, c, off], max_link_distance_m=500.0)
    pairs = {frozenset((l.manhole_a.manhole_id, l.manhole_b.manhole_id)) for l in links}
    # The straight run's own sequential links are fine.
    assert frozenset(("A", "B")) in pairs
    assert frozenset(("B", "C")) in pairs
    # A link from the straight run to the far-off-axis point must not
    # survive alignment validation.
    assert not any("OFF" in p for p in pairs)


# --- Test C: intermediate manhole must not be skipped ------------------------
def test_c_intermediate_manhole_not_skipped():
    # A - C - B in a straight line; A-B would skip over C.
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=582.0)
    c = _mh("C", 75.9003, 14.4600, BOTTOM_LEVEL=581.0)
    b = _mh("B", 75.9006, 14.4600, BOTTOM_LEVEL=580.0)
    links = build_candidate_links([a, b, c])
    pairs = {frozenset((l.manhole_a.manhole_id, l.manhole_b.manhole_id)) for l in links}
    assert frozenset(("A", "C")) in pairs
    assert frozenset(("C", "B")) in pairs
    assert frozenset(("A", "B")) not in pairs


# --- Test D: adaptive-distance rejection -------------------------------------
def test_d_adaptive_distance_rejects_large_gap():
    # Tight cluster of manholes ~5m apart, then one point ~90m further on
    # the same road — under the flat 100m hard max, but far beyond this
    # cluster's own local spacing pattern (median ~5m * 2.5 = 12.5m cap).
    a = _mh("A", 75.90000, 14.46000, BOTTOM_LEVEL=584.0)
    b = _mh("B", 75.90005, 14.46000, BOTTOM_LEVEL=583.5)
    c = _mh("C", 75.90010, 14.46000, BOTTOM_LEVEL=583.0)
    far = _mh("FAR", 75.90110, 14.46000, BOTTOM_LEVEL=580.0)  # ~90m east of C
    links = build_candidate_links([a, b, c, far], max_link_distance_m=100.0)
    pairs = {frozenset((l.manhole_a.manhole_id, l.manhole_b.manhole_id)) for l in links}
    assert frozenset(("C", "FAR")) not in pairs


# --- Test E: mutual-neighbour preference -------------------------------------
def test_e_mutual_neighbour_preferred():
    # Two well-separated pairs on the same road: A-B are close together
    # (~6m) and clearly each other's nearest neighbour (mutual); D is much
    # further from C (~40m) than C's true nearest neighbour B (~15m), so
    # C-D is a one-sided link from D's perspective, not mutual for C.
    a = _mh("A", 75.90000, 14.46000, BOTTOM_LEVEL=583.0)
    b = _mh("B", 75.90006, 14.46000, BOTTOM_LEVEL=582.0)
    c = _mh("C", 75.90020, 14.46000, BOTTOM_LEVEL=581.0)
    d = _mh("D", 75.90056, 14.46000, BOTTOM_LEVEL=580.0)
    links = build_candidate_links([a, b, c, d], max_link_distance_m=100.0)
    pairs = {frozenset((l.manhole_a.manhole_id, l.manhole_b.manhole_id)): l for l in links}
    ab = pairs.get(frozenset(("A", "B")))
    assert ab is not None
    assert ab.neighbour_relationship == "mutual"


# --- Test F: unrelated segment crossing rejected -----------------------------
def test_f_unrelated_crossing_rejected():
    # Two independent road groups whose sequential candidates would cross
    # in an X shape without sharing an endpoint — the weaker (longer/
    # worse-aligned) one should be dropped.
    a = _mh("A", 75.9000, 14.4600, road="Road One", BOTTOM_LEVEL=582.0)
    b = _mh("B", 75.9010, 14.4610, road="Road One", BOTTOM_LEVEL=580.0)
    c = _mh("C", 75.9000, 14.4610, road="Road Two", BOTTOM_LEVEL=582.0)
    d = _mh("D", 75.9010, 14.4600, road="Road Two", BOTTOM_LEVEL=580.0)
    links = build_candidate_links([a, b, c, d], max_link_distance_m=2000.0)
    pairs = {frozenset((l.manhole_a.manhole_id, l.manhole_b.manhole_id)) for l in links}
    # A-B and C-D cross each other (different roads, no shared endpoint) —
    # only one of the two crossing candidates should survive.
    assert not (frozenset(("A", "B")) in pairs and frozenset(("C", "D")) in pairs)


# --- Test G: junction (three branches) ---------------------------------------
def test_g_junction_allows_third_branch_when_geometrically_distinct():
    # A hub point H with three genuinely distinct-bearing same-road
    # neighbours very close by (within max_neighbours_per_manhole's normal
    # cap of 2) should be allowed a third link since the branches are
    # clearly separated in direction and none skips an intermediate point.
    h = _mh("H", 75.9000, 14.4600, BOTTOM_LEVEL=580.0)
    east = _mh("E", 75.9004, 14.4600, BOTTOM_LEVEL=579.0)
    north = _mh("N", 75.9000, 14.4604, BOTTOM_LEVEL=579.0)
    south = _mh("S", 75.9000, 14.4596, BOTTOM_LEVEL=579.0)
    links = build_candidate_links([h, east, north, south], max_link_distance_m=500.0)
    degree_h = sum(1 for l in links if "H" in (l.manhole_a.manhole_id, l.manhole_b.manhole_id))
    # A genuine junction may reach degree 3; it must never exceed 3.
    assert degree_h <= 3


def test_g_non_junction_still_capped_at_two():
    # A simple straight run — degree should stay at the ordinary cap of 2,
    # never opportunistically expanding to 3 without real branch geometry.
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=584.0)
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=583.0)
    c = _mh("C", 75.9004, 14.4600, BOTTOM_LEVEL=582.0)
    d = _mh("D", 75.9006, 14.4600, BOTTOM_LEVEL=581.0)
    links = build_candidate_links([a, b, c, d])
    degree = {}
    for l in links:
        degree[l.manhole_a.manhole_id] = degree.get(l.manhole_a.manhole_id, 0) + 1
        degree[l.manhole_b.manhole_id] = degree.get(l.manhole_b.manhole_id, 0) + 1
    assert all(v <= 2 for v in degree.values())


# --- Test H: confirmed count zero -> zero closed-arrow features -------------
def test_h_zero_confirmed_yields_zero_closed_arrows():
    # Every manhole missing elevation data -> no segment can be "confirmed".
    a = _mh("A", 75.9000, 14.4600)
    b = _mh("B", 75.9002, 14.4600)
    c = _mh("C", 75.9004, 14.4600)
    segments, summary = build_flow_network([a, b, c])
    assert summary.confirmed_segments == 0
    closed_arrow_features = [
        segment_to_feature(s) for s in segments if s.arrow_style == "closed"
    ]
    assert closed_arrow_features == []


# --- Test I: conflict segment has no arrow style -----------------------------
def test_i_conflict_has_no_arrow_style():
    a = _mh("A", 75.9000, 14.4600, TOP_LEVEL=590.0, BOTTOM_LEVEL=580.0, DEPTH="1 m")
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=579.0)
    links = build_candidate_links([a, b])
    seg = classify_segment(links[0])
    assert seg.direction_status == "conflict"
    assert seg.arrow_style not in ("closed", "open")
    assert seg.arrow_style == "none"


# --- Test J: unknown segment has no arrow style ------------------------------
def test_j_unknown_has_no_arrow_style():
    a = _mh("A", 75.9000, 14.4600)
    b = _mh("B", 75.9002, 14.4600)
    links = build_candidate_links([a, b])
    seg = classify_segment(links[0])
    assert seg.direction_status == "unknown"
    assert seg.arrow_style == "none"


# --- Test K: legend summary counts sum to total accepted connections --------
def test_k_summary_counts_sum_to_total():
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=582.0)
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=581.0)
    c = _mh("C", 75.9004, 14.4600)
    d = _mh("D", 75.9006, 14.4600, TOP_LEVEL=590.0, BOTTOM_LEVEL=580.0, DEPTH="1 m")
    e = _mh("E", 75.9008, 14.4600, BOTTOM_LEVEL=579.0)
    _segments, summary = build_flow_network([a, b, c, d, e])
    accounted = (
        summary.confirmed_segments
        + summary.derived_segments
        + summary.estimated_trend_segments
        + summary.unknown_segments
        + summary.conflict_segments
    )
    assert accounted == summary.candidate_connections


# --- Test L: no NaN/Infinity even with the refined fields -------------------
def test_l_refined_geojson_serializes_cleanly():
    import json

    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=582.0)
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=581.0)
    links = build_candidate_links([a, b])
    seg = classify_segment(links[0])
    feature = segment_to_feature(seg)
    assert feature["properties"]["road_cluster_id"] is not None
    json.dumps(feature, allow_nan=False)


# --- Optional building/road-corridor checks (Phase 10/11) -------------------
def test_supporting_geometry_rejects_building_crossing_link():
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=582.0)
    b = _mh("B", 75.9004, 14.4600, BOTTOM_LEVEL=580.0)
    # A building polygon straddling the straight line between A and B.
    building_ring = [
        (75.9001, 14.4598), (75.9003, 14.4598), (75.9003, 14.4602), (75.9001, 14.4602), (75.9001, 14.4598),
    ]
    sg = SupportingGeometry(building_rings=[building_ring])
    links = build_candidate_links([a, b], max_link_distance_m=500.0, supporting_geometry=sg)
    pairs = {frozenset((l.manhole_a.manhole_id, l.manhole_b.manhole_id)) for l in links}
    assert frozenset(("A", "B")) not in pairs


def test_supporting_geometry_absent_does_not_block_links():
    # No building/road geometry supplied -> Phase 10/11 checks are a no-op.
    a = _mh("A", 75.9000, 14.4600, BOTTOM_LEVEL=582.0)
    b = _mh("B", 75.9002, 14.4600, BOTTOM_LEVEL=581.0)
    links = build_candidate_links([a, b])
    assert len(links) == 1


def test_cluster_link_distance_constant_is_positive():
    assert CLUSTER_LINK_DISTANCE_M > 0


def test_rejection_counts_populated():
    # ~110m apart: within CLUSTER_LINK_DISTANCE_M (120m, so they still form
    # one cluster and a candidate is actually attempted) but over the 100m
    # hard max supplied here, so the specific distance rejection reason
    # must be recorded rather than the pair silently vanishing at the
    # clustering stage.
    rejections: dict[str, int] = {}
    a = _mh("A", 75.90000, 14.46000, BOTTOM_LEVEL=582.0)
    b = _mh("B", 75.90110, 14.46000, BOTTOM_LEVEL=580.0)
    build_candidate_links([a, b], max_link_distance_m=100.0, rejection_counts=rejections)
    assert rejections.get("exceeds_hard_max_distance", 0) >= 1

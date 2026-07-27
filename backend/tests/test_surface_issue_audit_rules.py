from app.models.spatial_anomaly import AnomalyColor
from app.services.surface_issue_audit import pothole_repair_estimate, pothole_severity, standing_water_severity


def test_small_shallow_pothole_is_review_not_critical() -> None:
    score, color, reasons = pothole_severity(
        area_sqm=0.5,
        depth_m=0.03,
        volume_m3=0.015,
        road_distance_m=2.0,
    )

    assert 0 <= score < 60
    assert color is AnomalyColor.YELLOW
    assert "mapped_pothole" in reasons
    assert "on_or_near_road" in reasons


def test_deep_large_pothole_is_critical() -> None:
    score, color, reasons = pothole_severity(
        area_sqm=3.5,
        depth_m=0.25,
        volume_m3=0.4,
        road_distance_m=0.0,
    )

    assert score >= 80
    assert color is AnomalyColor.RED
    assert {"large_area", "deep_pothole", "high_repair_volume", "on_or_near_road"}.issubset(reasons)


def test_small_isolated_standing_water_is_review() -> None:
    score, color, reasons = standing_water_severity(
        area_sqm=2.0,
        road_distance_m=15.0,
        road_intersects=False,
        drain_distance_m=20.0,
        drain_intersects=False,
    )

    assert 0 <= score < 60
    assert color is AnomalyColor.YELLOW
    assert reasons == ["mapped_standing_water"]


def test_large_standing_water_on_road_is_critical() -> None:
    score, color, reasons = standing_water_severity(
        area_sqm=22.0,
        road_distance_m=0.0,
        road_intersects=True,
        drain_distance_m=5.0,
        drain_intersects=False,
    )

    assert score >= 80
    assert color is AnomalyColor.RED
    assert {"large_affected_area", "on_road", "near_drain"}.issubset(reasons)


def test_bituminous_deep_pothole_uses_document_152_rate() -> None:
    estimate = pothole_repair_estimate(
        area_sqm=3.4491,
        depth_m=0.051,
        road_category="Bituminous Road",
    )

    repair_method = estimate["recommended_repair_method"]
    assert repair_method.startswith("Deep pothole patching")
    assert "WBM" in repair_method
    assert "SDBC" in repair_method
    assert estimate["sr_item_code"] == "10.15(ii)"
    assert estimate["sr_rate_per_sqm"] == 635.0
    assert estimate["estimated_repair_cost_inr"] == 2190.18
    assert estimate["cost_estimate_basis"] == "mapped_area_sqm_times_kpwd_2026_27_document_152_rate"


def test_concrete_pothole_requires_manual_rate() -> None:
    estimate = pothole_repair_estimate(
        area_sqm=3.4491,
        depth_m=0.051,
        road_category="Concrete Road",
    )

    assert estimate["recommended_repair_method"] == "Concrete patch repair"
    assert estimate["estimated_repair_cost_inr"] is None
    assert estimate["cost_estimate_status"] == "manual_rate_required"


def test_pothole_repair_estimate_refuses_missing_area() -> None:
    estimate = pothole_repair_estimate(
        area_sqm=None,
        depth_m=0.051,
        road_category="Bituminous Road",
    )

    assert estimate["estimated_repair_cost_inr"] is None
    assert estimate["cost_estimate_status"] == "unavailable"

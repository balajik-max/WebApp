from app.services.visualization.layer_classifier import classify_layer


def test_standing_water_layer_is_classified_without_affecting_generic_polygons() -> None:
    result = classify_layer(
        "Standing_Water",
        ["MultiPolygon"],
        ["Area_sqm", "Shape_Area"],
    )
    assert result.dashboard_type == "standing_water"
    assert result.confidence >= 0.9

    generic = classify_layer("Polygon", ["MultiPolygon"], ["LAYER", "SHAPE_Area"])
    assert generic.dashboard_type == "generic_polygon"


def test_pathhole_bottom_and_top_surfaces_are_kept_separate() -> None:
    bottom = classify_layer(
        "Pathhole",
        ["MultiPolygon"],
        ["Area_sqm", "Elevation"],
    )
    top = classify_layer(
        "Pathhole_Top",
        ["MultiPolygon"],
        ["Area_sqm", "Elevation"],
    )

    assert bottom.dashboard_type == "potholes"
    assert top.dashboard_type == "pothole_reference"


def test_common_alternate_names_are_detected() -> None:
    pothole = classify_layer(
        "BBMP_Road_Defects_2026",
        ["Polygon"],
        ["Defect_ID", "Pothole_Depth_cm", "Volume_m3"],
    )
    waterlogging = classify_layer(
        "Waterlogging_Hotspots",
        ["Polygon"],
        ["Area_m2", "Water_Depth_m"],
    )

    assert pothole.dashboard_type == "potholes"
    assert waterlogging.dashboard_type == "standing_water"

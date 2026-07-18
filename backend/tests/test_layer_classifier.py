from app.services.visualization.layer_classifier import classify_layer


def test_known_gdb_layers_receive_specialized_dashboards():
    assert classify_layer(
        "Road_Centerline", ["LineString"], ["Road_Name", "Carriage_Way_Width"]
    ).dashboard_type == "roads"
    assert classify_layer(
        "SWD", ["LineString"], ["Silt_Level", "Top_Level", "Bottom_Level"]
    ).dashboard_type == "drainage"
    assert classify_layer(
        "Manhole", ["Point"], ["Depth", "Diameter", "Pipe_Type"]
    ).dashboard_type == "manholes"


def test_unknown_layer_uses_safe_geometry_fallback():
    result = classify_layer(
        "Dog_Census_Zones", ["Polygon"], ["Zone_Name", "Dog_Count", "Risk_Level"]
    )
    assert result.dashboard_type == "generic_polygon"
    assert result.confidence < 0.65

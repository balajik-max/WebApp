from app.services.road_inspection import _road_display_name, road_asset_counter_key


def test_road_display_name_prefers_known_attribute_aliases() -> None:
    assert _road_display_name(
        "Fallback label",
        {"Street Name": "Kalikadevi Road"},
    ) == "Kalikadevi Road"


def test_road_display_name_falls_back_to_label_when_attributes_are_blank() -> None:
    assert _road_display_name(
        "Ward Road 12",
        {"name": "-", "street": "   "},
    ) == "Ward Road 12"


def test_road_asset_counter_key_covers_ready_now_road_classes() -> None:
    assert road_asset_counter_key("Illumination_Asset") == "poles"
    assert road_asset_counter_key("Drainage_Asset") == "drains"
    assert road_asset_counter_key("Access_Point") == "manholes"
    assert road_asset_counter_key("Pothole") == "potholes"
    assert road_asset_counter_key("Standing_Water") == "standing_water"
    assert road_asset_counter_key("Power_Line") == "power_lines"
    assert road_asset_counter_key("Utility_Pole") == "utility_poles"
    assert road_asset_counter_key("Vegetation") is None

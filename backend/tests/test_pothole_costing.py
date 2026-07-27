import uuid
from datetime import date

from app.services.kpwd_sr_sync import extract_high_confidence_rates
from app.services.pothole_costing import _estimate_from_values, calculate_cost
from app.services.pothole_sr_2026_27 import (
    OFFICIAL_POTHOLE_RATES,
    classify_road_surface,
    depth_mm_from_metadata,
    suggested_item_code,
)


def test_verified_document_152_rates_are_present() -> None:
    assert OFFICIAL_POTHOLE_RATES["10.15(i)"].rate_per_sqm == 388.0
    assert OFFICIAL_POTHOLE_RATES["10.15(ii)"].rate_per_sqm == 635.0
    assert OFFICIAL_POTHOLE_RATES["10.5"].rate_per_sqm == 631.0


def test_depth_selects_shallow_or_deep_item() -> None:
    assert suggested_item_code(25.0) == "10.15(i)"
    assert suggested_item_code(25.01) == "10.15(ii)"
    assert depth_mm_from_metadata({"depth_cm": 5.1}) == 51.0


def test_all_supported_road_surface_aliases() -> None:
    assert classify_road_surface("Concrete Road") == "concrete"
    assert classify_road_surface("BT Road") == "bituminous"
    assert classify_road_surface("Interlocking Paver Block Road") == "paver"
    assert classify_road_surface("WBM Road") == "wbm"
    assert classify_road_surface("Wet Mix Macadam") == "wmm"
    assert classify_road_surface("Gravel Road") == "gravel"
    assert classify_road_surface("Earthen Road") == "earthen"
    assert classify_road_surface("Asphalt over concrete composite") == "composite"
    assert classify_road_surface(None) == "unknown"


def test_official_deep_rate_and_additional_charge_are_calculated() -> None:
    estimate = _estimate_from_values(
        anomaly_id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
        metadata={
            "area_sqm": 3.4491,
            "depth_cm": 5.1,
            "nearest_road_category": "Bituminous Road",
        },
        override={
            "financial_year": "2026-27",
            "estimate_date": date(2026, 7, 27),
            "rate_mode": "official",
            "selected_item_code": "10.15(ii)",
            "labour_enabled": True,
            "labour_charge_per_pothole_inr": 500.0,
            "additional_charge_reason": "Approved night mobilisation",
        },
    )
    assert estimate["rate"]["rate_per_sqm"] == 635.0
    assert estimate["base_repair_cost_inr"] == 2190.18
    assert estimate["total_repair_cost_inr"] == 2690.18


def test_concrete_road_uses_volume_and_2023_base_reference_for_2026_request() -> None:
    estimate = _estimate_from_values(
        anomaly_id=uuid.UUID("00000000-0000-0000-0000-000000000002"),
        metadata={
            "area_sqm": 3.4491,
            "depth_mm": 51,
            "nearest_road_category": "Concrete Road",
        },
        override={"financial_year": "2026-27", "estimate_date": date(2026, 7, 27)},
    )
    assert estimate["rate_mode"] == "official"
    assert estimate["selected_item_code"] == "6.6"
    assert estimate["quantity_unit"] == "m3"
    assert estimate["calculated_quantity"] == 0.1759
    assert estimate["base_repair_cost_inr"] == 1191.55
    assert estimate["rate"]["rate_basis_year"] == "2023-24"
    assert estimate["warning"]
    cement = next(row for row in estimate["materials"] if row["name"] == "OPC cement")
    assert cement["quantity"] == 0.0475
    assert cement["included_in_finished_rate"] is True


def test_paver_road_selects_80mm_finished_item() -> None:
    estimate = _estimate_from_values(
        anomaly_id=uuid.UUID("00000000-0000-0000-0000-000000000003"),
        metadata={
            "area_sqm": 2.0,
            "depth_mm": 80,
            "nearest_road_category": "Paver Block Road",
        },
        override={"financial_year": "2023-24", "selected_item_code": "6.8.2"},
    )
    assert estimate["selected_item_code"] == "6.8.2"
    assert estimate["base_repair_cost_inr"] == 2322.0


def test_manual_cubic_metre_rate_and_additional_charge() -> None:
    estimate = _estimate_from_values(
        anomaly_id=uuid.UUID("00000000-0000-0000-0000-000000000004"),
        metadata={
            "area_sqm": 3.4491,
            "depth_mm": 51,
            "nearest_road_category": "Concrete Road",
        },
        override={
            "rate_mode": "manual",
            "manual_rate_value": 7000.0,
            "manual_rate_unit": "m3",
            "labour_enabled": True,
            "labour_charge_per_pothole_inr": 502.0,
            "additional_charge_reason": "Engineer-approved special mobilisation",
        },
    )
    assert estimate["base_repair_cost_inr"] == 1231.3
    assert estimate["total_repair_cost_inr"] == 1733.3
    assert estimate["rate"]["status"] == "manual_user_rate"


def test_additional_charge_is_optional_and_added_only_when_enabled() -> None:
    without_charge = calculate_cost(
        quantity=3.4491,
        rate_value=635.0,
        labour_enabled=False,
        labour_charge=500.0,
    )
    assert without_charge == {
        "base_repair_cost_inr": 2190.18,
        "labour_charge_per_pothole_inr": 0.0,
        "total_repair_cost_inr": 2190.18,
    }

    with_charge = calculate_cost(
        quantity=3.4491,
        rate_value=635.0,
        labour_enabled=True,
        labour_charge=500.0,
    )
    assert with_charge["total_repair_cost_inr"] == 2690.18



def test_effective_date_selects_the_correct_2026_revision() -> None:
    base = {
        "area_sqm": 1.0,
        "depth_mm": 51.0,
        "nearest_road_category": "Bituminous Road",
    }
    april_1 = _estimate_from_values(
        anomaly_id=uuid.uuid4(), metadata=base,
        override={"financial_year": "2026-27", "estimate_date": date(2026, 4, 1), "selected_item_code": "10.15(ii)"},
    )
    april_4 = _estimate_from_values(
        anomaly_id=uuid.uuid4(), metadata=base,
        override={"financial_year": "2026-27", "estimate_date": date(2026, 4, 4), "selected_item_code": "10.15(ii)"},
    )
    july_4 = _estimate_from_values(
        anomaly_id=uuid.uuid4(), metadata=base,
        override={"financial_year": "2026-27", "estimate_date": date(2026, 7, 4), "selected_item_code": "10.15(ii)"},
    )
    assert april_1["rate"]["rate_value"] == 523.0
    assert april_4["rate"]["rate_value"] == 605.0
    assert july_4["rate"]["rate_value"] == 635.0

def test_text_pdf_parser_accepts_only_exact_high_confidence_item() -> None:
    sample = """
    Karnataka PWD rates effective 04-07-2027.
    Item 10.5 Filling potholes with Bituminous Concrete 40mm using VG-30 Unit m2
    previous rate 631.00 revised rate 690.00
    """
    rows = extract_high_confidence_rates(sample, "2027-28")
    assert len(rows) == 1
    assert rows[0]["item_code"] == "10.5"
    assert rows[0]["rate_value"] == 690.0
    assert rows[0]["effective_from"] == date(2027, 7, 4)

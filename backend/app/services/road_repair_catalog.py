"""Verified Karnataka PWD road-repair catalogue used by pothole estimates.

The catalogue deliberately separates a finished-item rate from the material
breakdown used to explain that item. Material amounts are informational when a
finished-item SR rate is applied and are never added again to the total.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable

DEFAULT_FINANCIAL_YEAR = "2026-27"
DEFAULT_ESTIMATE_DATE = date(2026, 7, 27)


@dataclass(frozen=True)
class MaterialSpec:
    name: str
    quantity_per_item_unit: float | None
    quantity_unit: str
    rate: float | None
    rate_unit: str | None
    rate_year: str | None
    source_document: str | None
    source_page: int | None
    note: str | None = None


@dataclass(frozen=True)
class RepairRate:
    financial_year: str
    item_code: str
    road_surfaces: tuple[str, ...]
    repair_method: str
    description: str
    unit: str
    rate: float
    effective_from: date
    source_document: str
    source_page: int | None
    status: str = "official_pdf_verified"
    gst_included: bool = False
    quantity_basis: str = "area"
    materials: tuple[MaterialSpec, ...] = field(default_factory=tuple)
    source_url: str | None = None

    @property
    def rate_per_sqm(self) -> float | None:
        """Legacy compatibility for the original bituminous-only service."""
        return self.rate if self.unit == "m2" else None


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().replace("_", " ").replace("-", " ").split())


def classify_road_surface(value: Any) -> str:
    text = normalize_text(value)
    if not text:
        return "unknown"
    if any(token in text for token in ("cement concrete", "concrete road", "cc road", "pcc road")) or text in {"concrete", "cc", "pcc"}:
        return "concrete"
    if any(token in text for token in ("interlock", "paver block", "paver road", "block pavement")):
        return "paver"
    if "wmm" in text or "wet mix macadam" in text:
        return "wmm"
    if "wbm" in text or "water bound macadam" in text:
        return "wbm"
    if "gravel" in text or "moorum" in text or "murrum" in text:
        return "gravel"
    if any(token in text for token in ("earthen", "earth road", "soil road", "mud road")):
        return "earthen"
    if any(token in text for token in ("composite", "overlay on concrete", "asphalt over concrete")):
        return "composite"
    if any(token in text for token in ("bituminous", "asphalt", "blacktop", "black top", "tar road", "flexible pavement", "bt road", "bc road")):
        return "bituminous"
    return "unknown"


def depth_mm_from_metadata(metadata: dict[str, Any]) -> float | None:
    for key, multiplier in (("depth_m", 1000.0), ("depth_cm", 10.0), ("depth_mm", 1.0), ("repair_depth_mm", 1.0)):
        raw = metadata.get(key)
        if raw in (None, ""):
            continue
        try:
            value = float(raw) * multiplier
        except (TypeError, ValueError):
            continue
        if value >= 0:
            return round(value, 2)
    return None


MATERIAL_RATES_2023_24: dict[str, MaterialSpec] = {
    "cement": MaterialSpec("OPC cement", None, "t", 5860.0, "INR/t", "2023-24", "Common SR Volume I", 74),
    "coarse_sand": MaterialSpec("Coarse sand", None, "m3", 1476.0, "INR/m3", "2023-24", "Common SR Volume I", 74),
    "aggregate_20": MaterialSpec("20 mm stone aggregate", None, "m3", 1333.0, "INR/m3", "2023-24", "Common SR Volume I", 74),
    "aggregate_10": MaterialSpec("10 mm stone aggregate", None, "m3", 1362.0, "INR/m3", "2023-24", "Common SR Volume I", 74),
    "admixture": MaterialSpec("Concrete admixture", None, "kg", 191.0, "INR/kg", "2023-24", "Common SR Volume I", 70),
    "ggbs": MaterialSpec("GGBS", None, "t", 3810.0, "INR/t", "2023-24", "Common SR Volume I", 8),
    "paver_60": MaterialSpec("Factory-made paver block 60 mm", None, "m2", 660.0, "INR/m2", "2023-24", "Roads & Bridges SR Volume III", 12),
    "paver_80": MaterialSpec("Factory-made paver block 80 mm", None, "m2", 720.0, "INR/m2", "2023-24", "Roads & Bridges SR Volume III", 12),
    "paver_100_medium": MaterialSpec("Factory-made paver block 100 mm medium duty", None, "m2", 800.0, "INR/m2", "2023-24", "Roads & Bridges SR Volume III", 12),
    "paver_100_heavy": MaterialSpec("Factory-made paver block 100 mm heavy duty", None, "m2", 950.0, "INR/m2", "2023-24", "Roads & Bridges SR Volume III", 12),
}

MATERIAL_RATES_2026_27: dict[str, MaterialSpec] = {
    "vg40": MaterialSpec("VG40 bitumen", None, "t", 86852.0, "INR/t", "2026-27", "Document 152", 2),
    "vg30": MaterialSpec("VG30 bitumen", None, "t", 79440.0, "INR/t", "2026-27", "Document 152", 2),
    "vg10": MaterialSpec("VG10 bitumen", None, "t", 80440.0, "INR/t", "2026-27", "Document 152", 2),
    "pmb70e10": MaterialSpec("PMB 70E-10", None, "t", 116562.0, "INR/t", "2026-27", "Document 152", 2),
}


def _mat(base: MaterialSpec, qty: float | None, qty_unit: str | None = None, note: str | None = None) -> MaterialSpec:
    return MaterialSpec(
        name=base.name,
        quantity_per_item_unit=qty,
        quantity_unit=qty_unit or base.quantity_unit,
        rate=base.rate,
        rate_unit=base.rate_unit,
        rate_year=base.rate_year,
        source_document=base.source_document,
        source_page=base.source_page,
        note=note or base.note,
    )


RATES: tuple[RepairRate, ...] = (
    RepairRate("2023-24", "10.15(i)", ("bituminous", "composite"), "Shallow pothole patching with 25 mm SDBC Grade II", "Patching shallow potholes on asphalt surfaces, including preparation and tack coat.", "m2", 263.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 93, materials=(_mat(MATERIAL_RATES_2023_24["aggregate_10"], None, note="Aggregate quantity is governed by the approved SDBC mix design."),)),
    RepairRate("2023-24", "10.15(ii)", ("bituminous", "composite"), "Deep pothole patching with WBM Grade I and 25 mm SDBC Grade II", "Restores granular base and applies SDBC wearing course.", "m2", 497.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 93),
    RepairRate("2023-24", "10.5", ("bituminous", "composite"), "40 mm bituminous-concrete patch repair", "Filling potholes and patch repairs with 40 mm bituminous concrete using VG-30.", "m2", 426.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 91),
    RepairRate(
        "2023-24", "6.6", ("concrete",), "M30 plain cement-concrete pavement slab patch", "Plain M30 pavement-quality concrete with OPC and GGBS, laid without paver; groove cutting is separate.", "m3", 6774.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 51, quantity_basis="volume",
        materials=(
            _mat(MATERIAL_RATES_2023_24["cement"], 0.270, "t", "Item 6.6 specifies 270 kg OPC per m3."),
            _mat(MATERIAL_RATES_2023_24["ggbs"], 0.090, "t", "Item 6.6 specifies 90 kg GGBS per m3."),
            _mat(MATERIAL_RATES_2023_24["coarse_sand"], 0.450, "m3", "Indicative M30 coefficient from Common SR Volume I; final batching follows the approved mix design."),
            _mat(MATERIAL_RATES_2023_24["aggregate_20"], 0.540, "m3", "Indicative M30 coefficient from Common SR Volume I."),
            _mat(MATERIAL_RATES_2023_24["aggregate_10"], 0.360, "m3", "Indicative M30 coefficient from Common SR Volume I."),
            _mat(MATERIAL_RATES_2023_24["admixture"], 1.440, "kg", "0.4% of 360 kg total cementitious material per m3."),
        ),
    ),
    RepairRate("2023-24", "6.8.1", ("paver",), "60 mm M30 precast paver-block repair", "Cycle tracks and pedestrian areas, including sand bed and joint filling.", "m2", 1068.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 51, materials=(_mat(MATERIAL_RATES_2023_24["paver_60"], 1.0),)),
    RepairRate("2023-24", "6.8.2", ("paver",), "80 mm M30 precast paver-block repair", "Residential streets and commercial traffic up to 10 MSA, including sand bed and joint filling.", "m2", 1161.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 51, materials=(_mat(MATERIAL_RATES_2023_24["paver_80"], 1.0),)),
    RepairRate("2023-24", "6.8.3", ("paver",), "100 mm M40 precast paver-block repair - medium traffic", "Industrial streets and bus/truck parking for traffic above 10 MSA up to 20 MSA.", "m2", 1300.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 52, materials=(_mat(MATERIAL_RATES_2023_24["paver_100_medium"], 1.0),)),
    RepairRate("2023-24", "6.8.4", ("paver",), "100 mm M40 precast paver-block repair - heavy traffic", "Arterial streets for traffic above 20 MSA up to 50 MSA.", "m2", 1483.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 52, materials=(_mat(MATERIAL_RATES_2023_24["paver_100_heavy"], 1.0),)),
    RepairRate("2023-24", "6.8.5", ("paver",), "Permeable concrete paver-block repair", "Permeable concrete pavers for pedestrian areas including sand bed and joint filling.", "m2", 1019.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 52),
    RepairRate("2023-24", "16.18", ("wbm",), "Maintenance of WBM road", "Filling potholes and ruts, rectifying corrugation, damaged edges and ravelling.", "m2", 307.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 147),
    RepairRate("2023-24", "4.17", ("wmm",), "Wet Mix Macadam restoration", "Providing, laying and compacting graded stone aggregate to WMM specification.", "m3", 2559.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 26, quantity_basis="volume"),
    RepairRate("2023-24", "10.1", ("gravel",), "Gravel/moorum road restoration", "Restoration using soil, moorum, gravel or a mixture and compaction.", "m3", 188.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 91, quantity_basis="volume"),
    RepairRate("2023-24", "10.2", ("earthen",), "Earthen-road/shoulder filling with fresh soil", "Making up loss of material and compacting to approved level.", "m2", 97.0, date(2023, 11, 15), "Roads & Bridges SR Volume III", 91),
    RepairRate("2026-27", "10.15(i)", ("bituminous", "composite"), "Shallow pothole patching with 25 mm SDBC Grade II", "Patching shallow potholes on asphalt surfaces.", "m2", 284.0, date(2026, 1, 6), "Document 152", 4),
    RepairRate("2026-27", "10.15(i)", ("bituminous", "composite"), "Shallow pothole patching with 25 mm SDBC Grade II", "Patching shallow potholes on asphalt surfaces.", "m2", 355.0, date(2026, 4, 4), "Document 152", 4),
    RepairRate("2026-27", "10.15(ii)", ("bituminous", "composite"), "Deep pothole patching with WBM Grade I and 25 mm SDBC Grade II", "Restores granular base and applies SDBC wearing course.", "m2", 523.0, date(2026, 1, 6), "Document 152", 5),
    RepairRate("2026-27", "10.15(ii)", ("bituminous", "composite"), "Deep pothole patching with WBM Grade I and 25 mm SDBC Grade II", "Restores granular base and applies SDBC wearing course.", "m2", 605.0, date(2026, 4, 4), "Document 152", 5),
    RepairRate("2026-27", "10.5", ("bituminous", "composite"), "40 mm bituminous-concrete patch repair", "Filling potholes and patch repairs with 40 mm bituminous concrete using VG-30.", "m2", 461.0, date(2026, 1, 6), "Document 152", 4),
    RepairRate("2026-27", "10.5", ("bituminous", "composite"), "40 mm bituminous-concrete patch repair", "Filling potholes and patch repairs with 40 mm bituminous concrete using VG-30.", "m2", 578.0, date(2026, 4, 4), "Document 152", 4),
    RepairRate("2026-27", "10.15(i)", ("bituminous", "composite"), "Shallow pothole patching with 25 mm SDBC Grade II", "Patching shallow potholes on asphalt surfaces.", "m2", 388.0, date(2026, 7, 4), "Document 152", 4, materials=(_mat(MATERIAL_RATES_2026_27["vg30"], None, note="Binder quantity follows the approved SDBC mix design; this material value is informational."),)),
    RepairRate("2026-27", "10.15(ii)", ("bituminous", "composite"), "Deep pothole patching with WBM Grade I and 25 mm SDBC Grade II", "Restores granular base and applies SDBC wearing course.", "m2", 635.0, date(2026, 7, 4), "Document 152", 5, materials=(_mat(MATERIAL_RATES_2026_27["vg30"], None, note="Binder quantity follows the approved SDBC mix design; this material value is informational."),)),
    RepairRate("2026-27", "10.5", ("bituminous", "composite"), "40 mm bituminous-concrete patch repair", "Filling potholes and patch repairs with 40 mm bituminous concrete using VG-30.", "m2", 631.0, date(2026, 7, 4), "Document 152", 4, materials=(_mat(MATERIAL_RATES_2026_27["vg30"], None, note="Binder quantity follows the approved BC mix design; this material value is informational."),)),
)


def available_financial_years() -> list[str]:
    return sorted({r.financial_year for r in RATES}, reverse=True)


def rates_for_year(financial_year: str) -> list[RepairRate]:
    return [r for r in RATES if r.financial_year == financial_year]


def default_item_code(surface: str, depth_mm: float | None) -> str | None:
    if surface in {"bituminous", "composite", "unknown"}:
        return "10.15(i)" if depth_mm is not None and depth_mm <= 25 else "10.15(ii)"
    paver_item = "6.8.4" if depth_mm is not None and depth_mm >= 100 else ("6.8.2" if depth_mm is None or depth_mm >= 80 else "6.8.1")
    return {
        "concrete": "6.6",
        "paver": paver_item,
        "wbm": "16.18",
        "wmm": "4.17",
        "gravel": "10.1",
        "earthen": "10.2",
    }.get(surface)


def _eligible(records: Iterable[RepairRate], *, item_code: str, estimate_date: date) -> list[RepairRate]:
    return [r for r in records if r.item_code == item_code and r.effective_from <= estimate_date]


def resolve_rate(*, financial_year: str, item_code: str, estimate_date: date, road_surface: str) -> tuple[RepairRate | None, str | None]:
    exact = sorted(_eligible(rates_for_year(financial_year), item_code=item_code, estimate_date=estimate_date), key=lambda r: r.effective_from)
    if exact:
        selected = exact[-1]
        if road_surface not in selected.road_surfaces and road_surface != "unknown":
            return None, f"PWD item {item_code} is not applicable to the detected {road_surface} road surface."
        return selected, None

    # For 2026-27 non-bituminous roads, the supplied source set contains the
    # 2023-24 base item but no verified later finished-item revision. We expose
    # it as a transparent reference, not as a silently current 2026-27 rate.
    fallback = sorted(_eligible(rates_for_year("2023-24"), item_code=item_code, estimate_date=estimate_date), key=lambda r: r.effective_from)
    if fallback:
        selected = fallback[-1]
        if road_surface not in selected.road_surfaces and road_surface != "unknown":
            return None, f"PWD item {item_code} is not applicable to the detected {road_surface} road surface."
        return selected, (
            f"No verified {financial_year} finished-item revision for PWD item {item_code} was found in the supplied PDFs. "
            "The calculation uses the 2023-24 base SR reference and must be checked against the selected year's continuation/corrigendum before sanction."
        )
    return None, f"No verified Karnataka PWD rate was found for item {item_code} and financial year {financial_year}."



def source_url_for_document(source_document: str) -> str | None:
    normalized = normalize_text(source_document)
    if "document 152" in normalized:
        return "/api/v1/pothole-cost/source/document-152"
    if "issue rates 04" in normalized:
        return "/api/v1/pothole-cost/source/issue-rates-04"
    if "roads bridges sr volume iii" in normalized or "roads & bridges sr volume iii" in source_document.lower():
        return "/api/v1/pothole-cost/source/roads-bridges-2023-24"
    if "common sr volume i" in normalized:
        return "/api/v1/pothole-cost/source/common-sr-2023-24"
    return None

def rate_payload(rate: RepairRate, *, requested_year: str, warning: str | None = None) -> dict[str, Any]:
    status = rate.status if rate.financial_year == requested_year else "base_sr_reference_requires_verification"
    return {
        "rate_value": rate.rate,
        "rate_per_sqm": rate.rate if rate.unit == "m2" else None,
        "unit": f"INR/{rate.unit}",
        "source": "Karnataka PWD Schedule of Rates",
        "year": requested_year,
        "rate_basis_year": rate.financial_year,
        "item_code": rate.item_code,
        "item_description": rate.description,
        "effective_from": rate.effective_from,
        "source_document": rate.source_document,
        "source_page": rate.source_page,
        "source_url": rate.source_url or source_url_for_document(rate.source_document),
        "status": status,
        "verified_at": None,
        "last_sync_error": warning,
        "gst_included": rate.gst_included,
        "rate_mode": "official",
    }

"""Fixed canonical asset-class taxonomy for the spatial audit engine.

This is a small, reviewable domain model (not a database table) — it changes
rarely and should be visible in code review, unlike the per-dataset
raw-category -> canonical-class resolutions cached in CategoryClassMap.

Each class has a short description used as the semantic-matching target for
the embedding fallback in app.services.classification, plus a seed list of
known raw-category synonyms (lowercased, punctuation-stripped) that resolve
instantly without ever calling the embedding model.
"""
from __future__ import annotations

CANONICAL_CLASSES: dict[str, str] = {
    "Illumination_Asset": (
        "Street or area lighting hardware: light poles, solar lights, "
        "power poles with an integrated light fixture"
    ),
    "Access_Point": (
        "Underground utility access structures: manholes, inspection chambers, covers"
    ),
    "Drainage_Asset": (
        "Storm water drainage infrastructure: open drains, closed drains, culverts, silt traps"
    ),
    "Power_Line": "Overhead or underground electrical conductor lines",
    "Utility_Pole": "Poles carrying wires, transformers, or cameras but with no light fixture",
    "Road_Centerline": (
        "The single spine line running down the middle of a road — used to "
        "walk/sample a road for width and continuity checks, not the paved "
        "edge itself"
    ),
    "Road_Surface": (
        "The paved carriageway edge or footprint — concrete/asphalt road "
        "edges, used to measure the real width of the right-of-way against "
        "the centerline"
    ),
    "Road_Segment": (
        "Generic/ambiguous road right-of-way, footpaths, and sewage lines "
        "— any real right-of-way a new pipe can actually be dug along "
        "(manholes sit on these, not in the middle of a building), but not "
        "distinguishable as specifically the centerline or the paved edge"
    ),
    "Building": "Building footprints and structures",
    "Signage": "Road signage, markers, and street signs",
    "Vegetation": "Trees and other planted features",
    "Elevation_Contour": "Ground elevation contour lines from a topographic survey",
    "Drainage_Level_Point": (
        "Surveyed invert/top level, pipe type, diameter, and condition "
        "readings at a specific drain or manhole point — level survey "
        "data, not the drain channel geometry itself"
    ),
    "Pothole": (
        "Mapped road-surface depression or pavement defect polygon used for "
        "depth, area, severity, and repair-volume assessment"
    ),
    "Pothole_Reference": (
        "Top or surrounding road-surface reference polygon paired with a "
        "pothole bottom polygon for depth calculation"
    ),
    "Standing_Water": (
        "Mapped standing-water, waterlogging, ponding, or road-surface water polygon"
    ),
}

# Lowercased, whitespace/punctuation-normalized synonym seeds. Matched via
# exact string equality after normalization in classification.py — extend
# this list as new wards reveal new naming variants; it is the first, fastest,
# fully deterministic resolution path (no model call).
CLASS_SYNONYMS: dict[str, set[str]] = {
    "Illumination_Asset": {
        "light pole", "lightpole", "light_pole", "solar light", "solarlight",
        "solar_light", "solar light pole", "power pole with light",
        "power pole with light fixture", "streetlight", "street light",
        "street_light", "illumination asset",
    },
    "Access_Point": {
        "manhole", "man hole", "mh", "mh structure", "inspection chamber",
        "access chamber", "access point",
    },
    "Drainage_Asset": {
        "drain", "drain closed", "closed drain", "drain open", "open drain",
        "storm water drain", "swd", "culvert", "silt trap", "drainage",
    },
    "Power_Line": {"power line", "powerline", "poweline", "electric line", "overhead line"},
    "Utility_Pole": {"utility pole", "transformer pole", "cc camera pole"},
    "Road_Centerline": {
        "road centerline", "centerline", "center line", "carriageway centerline",
        "road center line",
    },
    "Road_Surface": {
        "concrete road", "concrete edge", "road edge", "carriageway",
        "asphalt road", "bituminous road", "tar road", "road surface",
    },
    "Road_Segment": {
        "road", "sidewalk", "footpath", "foot path", "sewage line", "sewage_line",
        "sewerage line", "sewer line",
    },
    "Building": {"building", "building extenstions", "building extensions"},
    "Signage": {"signage", "road signage", "sign"},
    "Vegetation": {"coconut tree", "tree", "vegetation"},
    "Elevation_Contour": {
        "contour", "contour line", "contour line minor", "contour line major",
        "contour line intermediate", "contour_line_minor", "contour_line_major",
        "contour_line_intermediate",
    },
    "Drainage_Level_Point": {
        "drain levels", "drain level", "manhole levels", "manhole level",
        "invert levels", "invert level", "level point", "level points",
    },
    "Pothole": {
        "pothole", "potholes", "pathhole", "pathholes",
        "road pothole", "road defect", "pavement defect",
    },
    "Pothole_Reference": {
        "pothole top", "pothole_top", "pathhole top", "pathhole_top",
        "pothole reference", "pothole top surface",
    },
    "Standing_Water": {
        "standing water", "standing_water", "water stagnation",
        "water_stagnation", "waterlogging", "water logging", "ponding",
    },
}


def normalize_category(raw: str) -> str:
    """Lowercase + collapse punctuation/underscores/whitespace for matching."""
    cleaned = raw.strip().lower()
    for ch in ("_", "-", "."):
        cleaned = cleaned.replace(ch, " ")
    return " ".join(cleaned.split())

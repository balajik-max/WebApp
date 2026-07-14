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
    "Road_Segment": "Carriageway centerlines, road edges, footpaths",
    "Building": "Building footprints and structures",
    "Signage": "Road signage, markers, and street signs",
    "Vegetation": "Trees and other planted features",
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
    "Power_Line": {"power line", "electric line", "overhead line"},
    "Utility_Pole": {"utility pole", "transformer pole", "cc camera pole"},
    "Road_Segment": {
        "concrete road", "road", "road centerline", "concrete edge",
        "sidewalk", "footpath", "foot path",
    },
    "Building": {"building", "building extenstions", "building extensions"},
    "Signage": {"signage", "road signage", "sign"},
    "Vegetation": {"coconut tree", "tree", "vegetation"},
}


def normalize_category(raw: str) -> str:
    """Lowercase + collapse punctuation/underscores/whitespace for matching."""
    cleaned = raw.strip().lower()
    for ch in ("_", "-", "."):
        cleaned = cleaned.replace(ch, " ")
    return " ".join(cleaned.split())

"""Deterministic layer classifier for the universal GDB dashboard engine.

The classifier deliberately uses inspectable rules (layer name, geometry and
field names) instead of silently asking a model to guess. Unknown layers are
kept useful through a geometry-specific generic dashboard and can be corrected
from the Layer Review screen.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable


DASHBOARD_TYPES: dict[str, str] = {
    "roads": "Road infrastructure",
    "drainage": "Storm-water drainage",
    "potholes": "Potholes and pavement defects",
    "pothole_reference": "Pothole top/reference surface",
    "standing_water": "Standing water and waterlogging",
    "manholes": "Manholes and access chambers",
    "streetlights": "Street-lighting infrastructure",
    "water_network": "Water-supply network",
    "sewer_network": "Sewer and UGD network",
    "buildings": "Buildings and structures",
    "parcels": "Land parcels and properties",
    "vegetation": "Trees and green assets",
    "solid_waste": "Solid-waste assets",
    "landmarks": "Landmarks and public facilities",
    "utilities": "Utility assets",
    "boundaries": "Administrative boundaries",
    "generic_point": "Other point assets",
    "generic_line": "Other linear assets",
    "generic_polygon": "Other area assets",
    "generic": "Other mapped layers",
}


@dataclass(slots=True, frozen=True)
class LayerClassification:
    dashboard_type: str
    confidence: float
    reasons: list[str]


def _normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _tokens(values: Iterable[str]) -> set[str]:
    return {normalized for value in values if (normalized := _normalize(value))}




_CANONICAL_LAYER_TYPES: dict[str, str] = {
    "road centerline": "roads",
    "road centreline": "roads",
    "roads": "roads",
    "manhole": "manholes",
    "manholes": "manholes",
    "swd": "drainage",
    "drain levels": "drainage",
    "drain level": "drainage",
    "landmark": "landmarks",
    "landmarks": "landmarks",
    "standing water": "standing_water",
    "water stagnation": "standing_water",
    "waterlogging": "standing_water",
    "pothole": "potholes",
    "potholes": "potholes",
    "pathhole": "potholes",
    "pathholes": "potholes",
    "pothole top": "pothole_reference",
    "pathhole top": "pothole_reference",
    # Generic source feature-class names must remain geometry-generic.
    # Their per-row LAYER/category values are analysed inside the utilities
    # dashboard and must not be silently reclassified as roads/buildings.
    "point": "generic_point",
    "line": "generic_line",
    "polygon": "generic_polygon",
}

_RULES: dict[str, dict[str, tuple[str, ...]]] = {
    "roads": {
        "name": ("road", "street", "centerline", "centreline", "carriageway", "footpath", "sidewalk"),
        "fields": ("road name", "street name", "road width", "carriage width", "carriage way width", "surface", "foot path", "footpath", "road usage"),
    },
    "drainage": {
        "name": ("drain", "swd", "storm water", "stormwater", "culvert", "nala"),
        "fields": ("silt level", "drain type", "width x depth", "widthxdepth", "top level", "bottom level"),
    },
    "potholes": {
        "name": ("pothole", "pathhole", "road defect", "road damage", "pavement defect", "surface defect"),
        "fields": ("pothole id", "defect id", "depth", "depth cm", "depth m", "area sqm", "volume m3", "elevation"),
    },
    "standing_water": {
        "name": ("standing water", "water stagnation", "waterlogging", "water logging", "ponding", "flood spot"),
        "fields": ("area sqm", "water depth", "standing water depth", "ponding depth", "volume m3"),
    },
    "manholes": {
        "name": ("manhole", "man hole", "mh", "inspection chamber", "access chamber"),
        "fields": ("manhole id", "mh id", "invert level", "rim level", "depth", "diameter", "pipe type"),
    },
    "streetlights": {
        "name": ("streetlight", "street light", "light pole", "lighting", "lamp", "illumination"),
        "fields": ("wattage", "luminaire", "working status", "lamp type", "light type"),
    },
    "water_network": {
        "name": ("water pipe", "water pipeline", "water main", "water network", "hydrant", "valve"),
        "fields": ("pressure", "pipe material", "water supply", "leak status", "valve type"),
    },
    "sewer_network": {
        "name": ("sewer", "sewage", "ugd", "underground drainage", "wastewater"),
        "fields": ("sewer type", "sewage", "invert level", "flow direction"),
    },
    "buildings": {
        "name": ("building", "structure", "footprint", "built up"),
        "fields": ("building use", "building type", "floor count", "roof type", "builtup area"),
    },
    "parcels": {
        "name": ("parcel", "property", "cadastral", "plot", "survey number"),
        "fields": ("property id", "parcel id", "plot number", "survey no", "owner name"),
    },
    "vegetation": {
        "name": ("tree", "vegetation", "green asset", "plantation", "canopy"),
        "fields": ("species", "tree height", "girth", "canopy", "tree condition"),
    },
    "solid_waste": {
        "name": ("garbage", "waste", "bin", "dump", "solid waste", "collection point"),
        "fields": ("bin capacity", "waste type", "collection frequency", "overflow"),
    },
    "landmarks": {
        "name": ("landmark", "school", "hospital", "temple", "mosque", "church", "community hall", "police station"),
        "fields": ("landmark name", "facility type", "institution name"),
    },
    "utilities": {
        "name": ("utility", "electric", "power", "transformer", "cable", "pole", "telecom", "gas"),
        "fields": ("utility type", "voltage", "transformer", "pole type", "cable type"),
    },
    "boundaries": {
        "name": ("boundary", "ward boundary", "zone boundary", "district boundary", "administrative boundary"),
        "fields": ("ward number", "ward name", "zone name", "boundary type"),
    },
}


def classify_layer(
    layer_name: str,
    geometry_types: Iterable[str],
    field_names: Iterable[str],
) -> LayerClassification:
    name = _normalize(layer_name)
    canonical_type = _CANONICAL_LAYER_TYPES.get(name)
    if canonical_type is not None:
        return LayerClassification(
            canonical_type,
            0.99,
            [f'Canonical source feature class "{layer_name}"'],
        )

    field_tokens = _tokens(field_names)
    scores: dict[str, float] = {key: 0.0 for key in _RULES}
    reasons: dict[str, list[str]] = {key: [] for key in _RULES}

    for dashboard_type, rule in _RULES.items():
        for keyword in rule["name"]:
            normalized_keyword = _normalize(keyword)
            if normalized_keyword and (
                normalized_keyword == name
                or normalized_keyword in name
                or name in normalized_keyword
            ):
                scores[dashboard_type] += 0.58
                reasons[dashboard_type].append(f'Layer name matches "{keyword}"')
                break

        matched_fields = []
        for keyword in rule["fields"]:
            normalized_keyword = _normalize(keyword)
            if any(
                normalized_keyword == field_name
                or normalized_keyword in field_name
                or (len(field_name) >= 6 and field_name in normalized_keyword)
                for field_name in field_tokens
            ):
                matched_fields.append(keyword)
        if matched_fields:
            scores[dashboard_type] += min(0.36, 0.09 * len(matched_fields))
            reasons[dashboard_type].append(
                "Relevant fields: " + ", ".join(matched_fields[:4])
            )

    normalized_geometry = {str(value).upper().replace("ST_", "") for value in geometry_types}
    point_only = bool(normalized_geometry) and normalized_geometry <= {"POINT", "MULTIPOINT"}
    line_only = bool(normalized_geometry) and normalized_geometry <= {"LINESTRING", "MULTILINESTRING"}
    polygon_only = bool(normalized_geometry) and normalized_geometry <= {"POLYGON", "MULTIPOLYGON"}

    # Geometry is supporting evidence, never enough by itself for a domain label.
    for key in ("manholes", "streetlights", "vegetation", "solid_waste", "landmarks"):
        if point_only and scores[key] > 0:
            scores[key] += 0.08
            reasons[key].append("Point geometry supports this asset type")
    for key in ("roads", "drainage", "water_network", "sewer_network", "utilities"):
        if line_only and scores[key] > 0:
            scores[key] += 0.08
            reasons[key].append("Line geometry supports this network type")
    for key in ("buildings", "parcels", "boundaries", "potholes", "standing_water"):
        if polygon_only and scores[key] > 0:
            scores[key] += 0.08
            reasons[key].append("Polygon geometry supports this area type")

    best_type = max(scores, key=scores.get)
    best_score = scores[best_type]
    if best_score >= 0.48:
        confidence = min(0.99, best_score)
        return LayerClassification(best_type, confidence, reasons[best_type])

    if point_only:
        fallback = "generic_point"
    elif line_only:
        fallback = "generic_line"
    elif polygon_only:
        fallback = "generic_polygon"
    else:
        fallback = "generic"
    return LayerClassification(
        fallback,
        0.35,
        ["No confident domain match; using a safe geometry-based generic dashboard"],
    )

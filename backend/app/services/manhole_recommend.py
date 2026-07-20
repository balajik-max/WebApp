"""Shared manhole condition/level parsing helpers, plus a small deterministic
pipe-spec recommendation.

This module used to also contain the full "AI Manhole Recommendation" engine
(pipe-CONNECTION suggestions via road/sewage-line routing, disconnected-
manhole detection, and the full drainage network view) — removed once the
survey data included real Sewage Line geometry, which made inferring/
proposing connections unnecessary. What remains: the text-parsing helpers
app.services.spatial_audit's Condition-based manhole_status audit still
depends on (untouched by the removal), plus `recommend_pipe_spec`, a
same-manhole-only material/diameter suggestion used by the AI explanation
for a bad/borderline finding — grounded entirely in that manhole's own
surveyed Pipe_Type/Diameter fields, no routing or connectivity involved.
"""
from __future__ import annotations

import re

# Unit-aware parsing: survey fields mix metres, centimetres, feet and inches
# ("577.064", "5 m", "3 feet", "10 Inches", "2 Feet", "250"). We extract the
# number and an optional unit, then convert to a canonical unit.
_NUMBER_UNIT_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*(cm|mm|m|ft|in|inch|feet|meters)?", re.IGNORECASE)

_UNIT_TO_M = {
    "m": 1.0, "meter": 1.0, "meters": 1.0,
    "cm": 0.01,
    "mm": 0.001,
    "ft": 0.3048, "feet": 0.3048,
    "in": 0.0254, "inch": 0.0254, "inches": 0.0254,
}
_UNIT_TO_MM = {
    "m": 1000.0, "meter": 1000.0, "meters": 1000.0,
    "cm": 10.0,
    "mm": 1.0,
    "ft": 304.8, "feet": 304.8,
    "in": 25.4, "inch": 25.4, "inches": 25.4,
}

# Standard commercial pipe diameters (mm) available for the upsize
# recommendation.
STANDARD_PIPE_DIAMETERS_MM: list[int] = [150, 200, 225, 250, 300, 375, 450, 500]


def _extract_number_with_unit(raw, unit_table: dict, default_unit: str = "m") -> float | None:
    """Pull a number + optional unit from free text and convert to the
    canonical unit. Returns None when no number is present (e.g.
    Top_Level="Blocked") — never guessed."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    m = _NUMBER_UNIT_RE.search(text)
    if not m:
        return None
    value = float(m.group(1))
    unit = (m.group(2) or default_unit).lower()
    return value * unit_table.get(unit, unit_table.get(default_unit, 1.0))


def parse_level_m(raw: str | None) -> float | None:
    """Parse an RL (reduced level) field into metres ("577.064", "568.132 m").
    Returns None for non-numeric values (e.g. "Blocked")."""
    return _extract_number_with_unit(raw, _UNIT_TO_M, default_unit="m")


def parse_inches_to_mm(raw: str | None) -> float | None:
    """Parse a diameter into millimetres ("10 Inches", "2 Feet", "250")."""
    return _extract_number_with_unit(raw, _UNIT_TO_MM, default_unit="mm")


def next_standard_diameter_mm(current_mm: float | None) -> float:
    """Round up to the next standard commercial pipe size. If the existing
    diameter is unknown, propose the smallest standard size rather than
    guessing a number — the assumption is stated by the caller."""
    if current_mm is None:
        return float(STANDARD_PIPE_DIAMETERS_MM[0])
    for size in STANDARD_PIPE_DIAMETERS_MM:
        if size >= current_mm:
            return float(size)
    return float(STANDARD_PIPE_DIAMETERS_MM[-1])


def recommend_material(existing_pipe_type: str | None, diameter_mm: float) -> str:
    """Prefer whatever material is already surveyed on this manhole
    (consistency with what's already installed); otherwise a standard
    default by size — RCC NP2 for larger diameters (structural load), PVC
    for smaller ones (cost)."""
    if existing_pipe_type and existing_pipe_type.strip():
        return existing_pipe_type.strip()
    return "RCC NP2" if diameter_mm >= 300 else "PVC"


def recommend_pipe_spec(attrs: dict) -> tuple[str, float, float | None] | None:
    """Same-manhole-only pipe spec suggestion from this manhole's own
    surveyed Pipe_Type/Diameter attributes — no routing, no other manhole
    involved. Returns (material, diameter_mm, existing_diameter_mm) or None
    when there's nothing to go on (should not happen in practice: an
    unknown diameter still yields the smallest standard size, so this only
    returns None if attrs itself is falsy)."""
    if not attrs:
        return None
    existing_pipe_type = (attrs.get("Pipe_Type") or "").strip() or None
    existing_diameter_mm = parse_inches_to_mm(attrs.get("Diameter"))
    diameter_mm = next_standard_diameter_mm(existing_diameter_mm)
    material = recommend_material(existing_pipe_type, diameter_mm)
    return material, diameter_mm, existing_diameter_mm


_BAD_CONDITION_TOKENS = (
    "bad", "blocked", "damage", "broken", "poor", "deteriorated",
    "choked", "collapsed", "defective", "cracked",
)
_GOOD_CONDITION_TOKENS = ("good", "fine", "ok", "working", "excellent", "satisfactory")


def is_bad_condition(condition: str | None) -> bool:
    if not condition:
        return False
    c = condition.strip().lower()
    return any(tok in c for tok in _BAD_CONDITION_TOKENS)


def is_good_condition(condition: str | None) -> bool:
    if not condition:
        return False
    c = condition.strip().lower()
    return any(tok in c for tok in _GOOD_CONDITION_TOKENS)


_MANHOLE_ISSUE_TOKENS = {
    "blockage": ("blocked", "choked", "blockage", "obstruct", "clogged", "plugged", "clog"),
    "garbage": ("garbage", "trash", "waste", "debris", "rubbish", "litter", "refuse"),
    "siltation": ("silt", "siltation", "sediment", "mud", "sludge"),
    "structural_damage": ("cracked", "broken", "damaged", "collapse", "collapsed", "defective", "deteriorated", "fracture"),
    "cover_issue": ("cover", "lid", "frame", "missing", "displaced", "loose"),
    "odor": ("odor", "odour", "smell", "stink", "foul"),
    "inflow": ("inflow", "infiltration", "leak", "leaking"),
}


def classify_manhole_issue(
    condition: str | None, top_level: str | None, silt_level: str | None, notes: str | None = None
) -> dict:
    """Classify specific manhole issues from survey attributes (free-text
    keyword match, deterministic — no LLM). Returns primary_issue, the full
    issues list, and a severity_hint used only to prioritize display."""
    text_parts = []
    for field in (condition, top_level, silt_level, notes):
        if field and str(field).strip():
            text_parts.append(str(field).strip().lower())
    combined = " ".join(text_parts)

    if not combined:
        return {"primary_issue": None, "issues": [], "severity_hint": "unknown"}

    found_issues = []
    for issue_type, tokens in _MANHOLE_ISSUE_TOKENS.items():
        if any(tok in combined for tok in tokens):
            found_issues.append(issue_type)

    if not found_issues:
        if is_bad_condition(condition):
            found_issues.append("general_deterioration")
        elif is_good_condition(condition):
            return {"primary_issue": None, "issues": ["no_issues_reported"], "severity_hint": "low"}

    primary = found_issues[0] if found_issues else "general_deterioration"
    severity = "high" if primary in ("blockage", "structural_damage", "garbage") else "medium"

    return {
        "primary_issue": primary,
        "issues": found_issues,
        "severity_hint": severity,
    }

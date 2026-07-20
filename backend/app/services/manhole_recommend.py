"""Shared manhole condition/level parsing helpers.

This module used to also contain the "AI Manhole Recommendation" engine
(pipe-connection suggestions, disconnected-manhole detection, and the full
drainage network view) — removed once the survey data included real Sewage
Line geometry, which made inferring/proposing connections unnecessary. What
remains here are the small text-parsing helpers that app.services.spatial_
audit's Condition-based manhole_status audit (Goal 3 in that module) still
depends on; that audit is unrelated to the removed recommendation engine and
is untouched.
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

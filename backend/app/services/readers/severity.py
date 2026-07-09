"""
Shared condition-based severity heuristic for the reader pipeline.

Real-world survey attribute schemas rarely ship an explicit numeric
severity/priority column — condition is usually described in free-text
fields instead, e.g. `"Manhole_Condition": "Poor"` or a narrative field
like `"Any_Conservancy": "...causing frequent manhole choking and
overflow"`. Without this, every feature defaults to severity 0.0, which
makes map hotspot ranking and the AI summarizer's "Top Hotspots" section
meaningless (nothing to rank). This scans every string attribute value
for known problem/urgency keywords and returns the highest-scoring
match found.

This is a heuristic, not ground truth — it is only used as a fallback
when no explicit numeric severity/priority/score column exists on the
dataset (see `_persist` in gis_reader.py / table_reader.py).
"""
from __future__ import annotations

from typing import Any

# Scored roughly by urgency. Matching is substring-based, case-insensitive,
# against every string attribute value; the highest score found wins.
_SEVERITY_KEYWORDS: dict[str, float] = {
    "collapsed": 0.95,
    "collapse": 0.95,
    "hazard": 0.9,
    "unsafe": 0.9,
    "critical": 0.9,
    "ruin": 0.9,
    "choking": 0.85,
    "overflow": 0.85,
    "broken": 0.85,
    "damaged": 0.8,
    "not working": 0.8,
    "needs repair": 0.8,
    "severe": 0.8,
    "deteriorated": 0.78,
    "leaking": 0.75,
    "leak": 0.75,
    "blocked": 0.7,
    "poor": 0.7,
    "bad": 0.68,
    "cracked": 0.65,
    "faulty": 0.65,
    "unauthorized": 0.6,
    "encroachment": 0.6,
    "obstructing": 0.6,
    "obstruction": 0.6,
    "congestion": 0.55,
    "debris": 0.55,
    "silt": 0.5,
    "partial": 0.45,
    "moderate": 0.45,
    "fair": 0.4,
    "average": 0.4,
    "good": 0.2,
    "excellent": 0.1,
    "new": 0.05,
    "under construction": 0.3,
}


def infer_severity_from_attributes(attributes: dict[str, Any]) -> float:
    """Return the highest-scoring condition/urgency keyword found in any
    string attribute value, or 0.0 if none of the known keywords appear."""
    best = 0.0
    for value in attributes.values():
        if not isinstance(value, str):
            continue
        low = value.lower()
        for keyword, score in _SEVERITY_KEYWORDS.items():
            if score > best and keyword in low:
                best = score
    return best

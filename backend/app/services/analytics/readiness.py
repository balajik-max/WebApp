"""Manhole data-readiness rules for the existing Gandhinagar GDB fields.

The rules are deliberately narrow and deterministic. They only inspect fields
that are meaningful for the Manhole category and never mutate source data.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from fastapi import HTTPException
from sqlalchemy import and_, func, not_, or_

from app.models import Feature

_EMPTY_TEXT_VALUES = ("", "-", "n/a", "na", "nan", "none", "null", "unknown")


@dataclass(frozen=True, slots=True)
class ManholeReadinessField:
    key: str
    label: str
    aliases: tuple[str, ...]
    recommended_action: str


MANHOLE_READINESS_FIELDS: tuple[ManholeReadinessField, ...] = (
    ManholeReadinessField(
        key="depth",
        label="Depth",
        aliases=("Depth",),
        recommended_action="Measure and record the manhole depth.",
    ),
    ManholeReadinessField(
        key="bottom_level",
        label="Bottom Level",
        aliases=("Bottom_Level",),
        recommended_action="Survey and record the bottom or invert level.",
    ),
    ManholeReadinessField(
        key="top_level",
        label="Top Level",
        aliases=("Top_Level",),
        recommended_action="Survey and record the top level.",
    ),
    ManholeReadinessField(
        key="condition",
        label="Condition",
        aliases=("Manhole_Condition", "Condition"),
        recommended_action="Inspect and record the manhole condition.",
    ),
    ManholeReadinessField(
        key="pipe_type",
        label="Pipe Type",
        aliases=("Pipe_Type",),
        recommended_action="Verify and record the connected pipe type.",
    ),
    ManholeReadinessField(
        key="diameter",
        label="Diameter",
        aliases=("Diameter", "Pipe_Dia"),
        recommended_action="Measure and record the diameter.",
    ),
    ManholeReadinessField(
        key="image_reference",
        label="Image Reference",
        aliases=("Image_Number", "Image"),
        recommended_action="Capture or link the site photograph reference.",
    ),
)

_FIELD_BY_KEY = {field.key: field for field in MANHOLE_READINESS_FIELDS}


def clean_missing_field(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip().lower()
    if not cleaned:
        return None
    if cleaned not in _FIELD_BY_KEY:
        allowed = ", ".join(field.key for field in MANHOLE_READINESS_FIELDS)
        raise HTTPException(
            status_code=400,
            detail=f"missing_field must be one of: {allowed}",
        )
    return cleaned


def get_readiness_field(key: str) -> ManholeReadinessField:
    cleaned = clean_missing_field(key)
    assert cleaned is not None
    return _FIELD_BY_KEY[cleaned]


def manhole_category_condition():
    return func.lower(func.trim(func.coalesce(Feature.category, ""))) == "manhole"


def _attribute_text(alias: str):
    return func.lower(func.trim(func.coalesce(Feature.attributes[alias].astext, "")))


def field_available_condition(field_key: str):
    field = get_readiness_field(field_key)
    populated = [not_(_attribute_text(alias).in_(_EMPTY_TEXT_VALUES)) for alias in field.aliases]
    return or_(*populated)


def field_missing_condition(field_key: str):
    return and_(manhole_category_condition(), not_(field_available_condition(field_key)))


def readiness_fields() -> Iterable[ManholeReadinessField]:
    return MANHOLE_READINESS_FIELDS

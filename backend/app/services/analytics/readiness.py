"""Deterministic Manhole data-readiness rules.

The rules only inspect existing attributes. They never modify a source GDB,
feature, or ingestion record.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal, Mapping

from fastapi import HTTPException
from sqlalchemy import and_, func, not_, or_

from app.models import Feature

_EMPTY_TEXT_VALUES = ("", "-", "n/a", "na", "nan", "none", "null", "unknown")
ReadinessStatus = Literal["all", "available", "missing"]


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


def clean_readiness_field(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip().lower()
    if not cleaned:
        return None
    if cleaned not in _FIELD_BY_KEY:
        allowed = ", ".join(field.key for field in MANHOLE_READINESS_FIELDS)
        raise HTTPException(
            status_code=400,
            detail=f"readiness_field must be one of: {allowed}",
        )
    return cleaned


def clean_missing_field(value: str | None) -> str | None:
    """Backward-compatible alias used by the Phase 4 missing-only API."""
    return clean_readiness_field(value)


def clean_readiness_status(value: str | None) -> ReadinessStatus:
    cleaned = (value or "all").strip().lower()
    if cleaned not in {"all", "available", "missing"}:
        raise HTTPException(
            status_code=400,
            detail="readiness_status must be one of: all, available, missing",
        )
    return cleaned  # type: ignore[return-value]


def resolve_readiness_filter(
    *,
    readiness_field: str | None = None,
    readiness_status: str | None = None,
    missing_field: str | None = None,
) -> tuple[str | None, ReadinessStatus | None]:
    """Resolve new readiness parameters while preserving missing_field clients."""
    cleaned_field = clean_readiness_field(readiness_field)
    legacy_field = clean_missing_field(missing_field)
    if cleaned_field and legacy_field and cleaned_field != legacy_field:
        raise HTTPException(
            status_code=400,
            detail="readiness_field and missing_field must reference the same field",
        )
    field = cleaned_field or legacy_field
    if not field:
        if readiness_status and readiness_status.strip().lower() not in {"", "all"}:
            raise HTTPException(
                status_code=400,
                detail="readiness_status requires readiness_field",
            )
        return None, None
    if legacy_field and readiness_status is None:
        return field, "missing"
    return field, clean_readiness_status(readiness_status)


def get_readiness_field(key: str) -> ManholeReadinessField:
    cleaned = clean_readiness_field(key)
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


def readiness_scope_condition(field_key: str, status: ReadinessStatus):
    if status == "available":
        return and_(manhole_category_condition(), field_available_condition(field_key))
    if status == "missing":
        return field_missing_condition(field_key)
    return manhole_category_condition()


def attribute_value(attributes: Mapping[str, object] | None, field_key: str) -> object | None:
    """Return the first meaningful configured alias value for one feature."""
    if not isinstance(attributes, Mapping):
        return None
    field = get_readiness_field(field_key)
    for alias in field.aliases:
        value = attributes.get(alias)
        if value is None:
            continue
        text = str(value).strip()
        if text.lower() in _EMPTY_TEXT_VALUES:
            continue
        return value
    return None


def attribute_readiness_status(
    attributes: Mapping[str, object] | None,
    field_key: str,
) -> Literal["available", "missing"]:
    return "available" if attribute_value(attributes, field_key) is not None else "missing"


def readiness_fields() -> Iterable[ManholeReadinessField]:
    return MANHOLE_READINESS_FIELDS

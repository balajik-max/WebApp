"""Shared presentation rules for GIS attribute tables."""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any


# These values identify a feature in common GIS formats. They are rendered as
# one fixed FID column rather than duplicated among the dynamic attributes.
FID_KEYS = frozenset({"fid", "objectid", "object_id"})

# ``gdb_layer`` is ingestion metadata used internally to remember which GDB
# feature class a row came from. It is not a source attribute and should not
# appear beside the user's real survey fields.
HIDDEN_ATTRIBUTE_KEYS = FID_KEYS | {"gdb_layer"}

_PREFERRED_DATA_COLUMNS = {
    "layer": 0,
    "shape_length": 1,
    "shape_area": 2,
}


def resolve_feature_fid(attributes: Mapping[str, Any] | None, fallback: int) -> str | int | float:
    """Return a source FID/ObjectID when present, otherwise a stable fallback."""
    for key, value in (attributes or {}).items():
        if key.casefold() not in FID_KEYS:
            continue
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        if isinstance(value, (str, int, float)):
            return value
        return str(value)
    return fallback


def order_attribute_columns(rows: Iterable[tuple[str, int]]) -> list[str]:
    """Put populated source fields first and completely empty fields last.

    Within the populated group, common GIS geometry measurements and the
    source LAYER field are kept at the front; remaining fields are ordered by
    how many records contain data and then alphabetically for determinism.
    """
    visible = [
        (str(name), int(populated_count or 0))
        for name, populated_count in rows
        if str(name).casefold() not in HIDDEN_ATTRIBUTE_KEYS
    ]
    visible.sort(
        key=lambda item: (
            item[1] == 0,
            _PREFERRED_DATA_COLUMNS.get(item[0].casefold(), len(_PREFERRED_DATA_COLUMNS)),
            -item[1],
            item[0].casefold(),
            item[0],
        )
    )
    return [name for name, _count in visible]


def populated_attribute_column_count(rows: Iterable[tuple[str, int]]) -> int:
    """Count visible attribute fields containing at least one real value."""
    return sum(
        1
        for name, populated_count in rows
        if str(name).casefold() not in HIDDEN_ATTRIBUTE_KEYS and int(populated_count or 0) > 0
    )

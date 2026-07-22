"""Backward-compatible road taxonomy support.

The road-width and road-inspection features were introduced after older
uploads had already been classified under the broad ``Road_Segment`` class.
Those existing rows live in the persistent PostGIS volume, so upgrading the
application code alone is not enough: the rows and the category-class cache
must be migrated to the newer ``Road_Centerline`` / ``Road_Surface`` split.

This module provides two safeguards:

* an idempotent deterministic backfill for existing data (no Ollama call), and
* reusable SQL category predicates so road analysis still works while a
  legacy row is waiting to be migrated.

Only raw categories that are explicit synonyms in ``class_taxonomy.py`` are
changed. Generic Road_Segment rows such as footpaths or sewage lines are never
promoted to a centerline or road surface.
"""
from __future__ import annotations

import logging
from collections.abc import Iterable

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category_class_map import CategoryClassMap, ClassMatchMethod
from app.services.class_taxonomy import CLASS_SYNONYMS, normalize_category

log = logging.getLogger("davangere.road_compat")

ROAD_CENTERLINE_CLASS = "Road_Centerline"
ROAD_SURFACE_CLASS = "Road_Surface"
ROAD_STALE_CLASSES = ("Unclassified", "Road_Segment")

ROAD_CENTERLINE_CATEGORY_KEYS = tuple(
    sorted(normalize_category(value) for value in CLASS_SYNONYMS[ROAD_CENTERLINE_CLASS])
)
ROAD_SURFACE_CATEGORY_KEYS = tuple(
    sorted(normalize_category(value) for value in CLASS_SYNONYMS[ROAD_SURFACE_CLASS])
)


def normalized_category_sql(alias: str) -> str:
    """Return a PostgreSQL expression matching ``normalize_category``.

    ``alias`` must be a trusted SQL table alias supplied by application code,
    never user input.
    """

    return (
        "regexp_replace("
        "regexp_replace(lower(trim(coalesce(" + alias + ".category, ''))), "
        "'[_\\-.]+', ' ', 'g'), "
        "'\\s+', ' ', 'g')"
    )


def road_class_predicate(alias: str, target_class: str, parameter_name: str) -> str:
    """Build a compatibility predicate for a road canonical class."""

    return (
        "("
        f"{alias}.attributes->>'_canonical_class' = '{target_class}' "
        f"OR {normalized_category_sql(alias)} = ANY(:{parameter_name})"
        ")"
    )


def _target_for_raw_category(raw_category: str) -> str | None:
    normalized = normalize_category(raw_category)
    if normalized in ROAD_CENTERLINE_CATEGORY_KEYS:
        return ROAD_CENTERLINE_CLASS
    if normalized in ROAD_SURFACE_CATEGORY_KEYS:
        return ROAD_SURFACE_CLASS
    return None


async def backfill_road_classification(
    session: AsyncSession,
    *,
    commit: bool = False,
) -> dict[str, int]:
    """Idempotently migrate legacy road rows and category-cache entries.

    The caller controls transaction ownership. Startup uses ``commit=True``;
    the spatial-audit transaction uses the default and commits together with
    its generated anomalies.
    """

    raw_categories: Iterable[str] = (
        await session.execute(
            text(
                "SELECT DISTINCT category FROM features "
                "WHERE category IS NOT NULL "
                "AND ("
                "  NOT (coalesce(attributes, '{}'::jsonb) ? '_canonical_class') "
                "  OR coalesce(attributes, '{}'::jsonb)->>'_canonical_class' = ANY(:stale_classes)"
                ")"
            ),
            {"stale_classes": list(ROAD_STALE_CLASSES)},
        )
    ).scalars().all()

    counts = {ROAD_CENTERLINE_CLASS: 0, ROAD_SURFACE_CLASS: 0}
    changed_categories: list[tuple[str, str]] = []

    for raw_category in raw_categories:
        if not raw_category:
            continue
        target = _target_for_raw_category(raw_category)
        if target is None:
            continue

        result = await session.execute(
            text(
                "UPDATE features "
                "SET attributes = coalesce(attributes, '{}'::jsonb) || jsonb_build_object('_canonical_class', CAST(:target AS text)) "
                "WHERE category = :raw_category "
                "AND ("
                "  NOT (coalesce(attributes, '{}'::jsonb) ? '_canonical_class') "
                "  OR coalesce(attributes, '{}'::jsonb)->>'_canonical_class' = ANY(:stale_classes)"
                ")"
            ),
            {
                "target": target,
                "raw_category": raw_category,
                "stale_classes": list(ROAD_STALE_CLASSES),
            },
        )
        updated = int(result.rowcount or 0)
        counts[target] += updated

        # Keep the cache authoritative for the frontend's class-map request and
        # for future uploads of the same raw category.
        await session.execute(
            pg_insert(CategoryClassMap)
            .values(
                raw_category=raw_category,
                canonical_class=target,
                match_method=ClassMatchMethod.EXACT,
                confidence=1.0,
            )
            .on_conflict_do_update(
                index_elements=[CategoryClassMap.raw_category],
                set_={
                    "canonical_class": target,
                    "match_method": ClassMatchMethod.EXACT,
                    "confidence": 1.0,
                },
            )
        )
        changed_categories.append((raw_category, target))

    await session.flush()
    if commit:
        await session.commit()

    if changed_categories:
        log.info(
            "Road taxonomy compatibility backfill: %d centerline row(s), %d surface row(s); categories=%s",
            counts[ROAD_CENTERLINE_CLASS],
            counts[ROAD_SURFACE_CLASS],
            changed_categories,
        )
    else:
        log.info("Road taxonomy compatibility backfill: no legacy road rows required migration")

    return counts

"""One-time backfill for three distinct data-quality gaps found while
extending the classification taxonomy (see class_taxonomy.py / classification.py
/ gis_reader.py):

1. Rows with NO `_canonical_class` key at all — classification was never
   attempted for them, because of the gdb_layer-fallback bug in
   gis_reader.py._persist() (now fixed for future uploads). Their `category`
   field is already correct (that fallback always worked); only the
   classification input was missing it.
2. Rows explicitly cached as `"Unclassified"` whose raw category is now a
   real synonym of a newly-added class (e.g. "Contour Line_ Minor" was
   embedding-scored at 0.55, just under the 0.60 threshold, before the
   Elevation_Contour class/synonyms existed). Their stale category_class_map
   cache entry is deleted first so resolution re-runs against the current
   taxonomy instead of returning the old result.
3. Rows cached under an OLDER, now-superseded umbrella class whose raw
   category moved to a newer, more specific class after a taxonomy split
   (e.g. "Concrete Road" / "Road Centerline" used to both resolve to the
   single "Road_Segment" umbrella; after the Road_Centerline/Road_Surface
   split, those raw categories are real synonyms of the new classes and
   must be re-resolved, not left pointing at the old umbrella). Same
   stale-cache-invalidation treatment as (2), just sourced from
   "Road_Segment" instead of "Unclassified".

Safe to re-run: (1) only touches rows where the key is genuinely absent;
(2)/(3) only invalidate cache entries that exactly match a NEW synonym, and
only for the specific raw_category strings that moved — never a blanket
reclassification of every row in the old class.

Usage: docker exec davangere_backend python -m app.scripts.backfill_classification
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging

from sqlalchemy import text

from app.db.session import SessionLocal
from app.services.class_taxonomy import CLASS_SYNONYMS, normalize_category
from app.services.classification import resolve_canonical_classes_bulk

log = logging.getLogger("davangere.scripts.backfill_classification")
logging.basicConfig(level=logging.INFO)

# Classes added incrementally after classification first ran across the
# whole dataset — restrict cache invalidation to their synonyms so we never
# touch a category that is genuinely, correctly Unclassified (or correctly
# still on the older umbrella class below).
_NEW_CLASSES = ("Elevation_Contour", "Drainage_Level_Point", "Road_Centerline", "Road_Surface")

# canonical_class values a cached row may be stuck on when its raw category
# is actually a synonym of one of _NEW_CLASSES above. "Road_Segment" is the
# pre-split umbrella that "Concrete Road"/"Concrete Edge"/"Road Centerline"
# used to resolve to before the road-width taxonomy split.
_STALE_SOURCE_CLASSES = ("Unclassified", "Road_Segment")


def _new_class_synonyms() -> set[str]:
    return {syn for cls in _NEW_CLASSES for syn in CLASS_SYNONYMS[cls]}


async def _invalidate_stale_unclassified_cache(session, dry_run: bool) -> int:
    new_synonyms = _new_class_synonyms()
    stale_rows = (
        await session.execute(
            text(
                "SELECT raw_category FROM category_class_map "
                "WHERE canonical_class = ANY(:source_classes)"
            ),
            {"source_classes": list(_STALE_SOURCE_CLASSES)},
        )
    ).scalars().all()
    to_delete = [c for c in stale_rows if normalize_category(c) in new_synonyms]
    if not to_delete:
        return 0
    if dry_run:
        log.info("[DRY-RUN] Would invalidate stale cache for: %s", to_delete)
        return len(to_delete)
    await session.execute(
        text("DELETE FROM category_class_map WHERE raw_category = ANY(:cats)"),
        {"cats": to_delete},
    )
    await session.commit()
    log.info("Invalidated stale cache for: %s", to_delete)
    return len(to_delete)


async def _target_categories(session) -> set[str]:
    missing_key_rows = (
        await session.execute(
            text(
                "SELECT DISTINCT category FROM features "
                "WHERE category IS NOT NULL AND NOT (attributes ? '_canonical_class')"
            )
        )
    ).scalars().all()
    explicit_unclassified_rows = (
        await session.execute(
            text(
                "SELECT DISTINCT category FROM features "
                "WHERE category IS NOT NULL AND attributes->>'_canonical_class' = 'Unclassified'"
            )
        )
    ).scalars().all()
    # Rows stuck on an older umbrella class (e.g. Road_Segment) whose raw
    # category is now a synonym of a newer, more specific class — same
    # "stale, needs re-resolving" shape as explicit_unclassified_rows above,
    # just sourced from a non-Unclassified class. Restricted to a real NEW
    # synonym match so a genuinely-still-generic row (e.g. "Footpath",
    # correctly still Road_Segment) is never touched.
    umbrella_classes = [c for c in _STALE_SOURCE_CLASSES if c != "Unclassified"]
    stale_umbrella_rows = (
        await session.execute(
            text(
                "SELECT DISTINCT category FROM features "
                "WHERE category IS NOT NULL AND attributes->>'_canonical_class' = ANY(:umbrella_classes)"
            ),
            {"umbrella_classes": umbrella_classes},
        )
    ).scalars().all()
    new_synonyms = _new_class_synonyms()
    stale_umbrella_targets = [c for c in stale_umbrella_rows if normalize_category(c) in new_synonyms]
    return {
        c for c in (*missing_key_rows, *explicit_unclassified_rows, *stale_umbrella_targets)
        if c and c.strip()
    }


async def _snapshot_target_rows(session, categories, snapshot_path: str) -> int:
    # Must cover exactly the row set the UPDATE below will touch (same
    # stale-classes guard) or a row reclassified away from an umbrella class
    # like Road_Segment would be silently excluded from the restore safety net.
    rows = (
        await session.execute(
            text(
                "SELECT id, attributes FROM features "
                "WHERE category = ANY(:cats) "
                "AND (NOT (attributes ? '_canonical_class') OR attributes->>'_canonical_class' = ANY(:stale_classes))"
            ),
            {"cats": list(categories), "stale_classes": list(_STALE_SOURCE_CLASSES)},
        )
    ).mappings().all()
    snap = [{"id": str(r["id"]), "attributes": r["attributes"]} for r in rows]
    with open(snapshot_path, "w") as fh:
        json.dump(snap, fh)
    log.info("Snapshot of %d rows written to %s", len(snap), snapshot_path)
    return len(snap)


async def _restore_from_snapshot(restore_path: str) -> None:
    with open(restore_path) as fh:
        snap = json.load(fh)
    async with SessionLocal() as session:
        for row in snap:
            await session.execute(
                text("UPDATE features SET attributes = CAST(:attrs AS jsonb) WHERE id = :id"),
                {"attrs": json.dumps(row["attributes"]), "id": row["id"]},
            )
        await session.commit()
    log.info("Restored %d rows from snapshot %s", len(snap), restore_path)


async def main(
    dry_run: bool = False,
    snapshot_path: str | None = None,
    restore_path: str | None = None,
) -> None:
    if restore_path:
        await _restore_from_snapshot(restore_path)
        return

    async with SessionLocal() as session:
        invalidated = await _invalidate_stale_unclassified_cache(session, dry_run)
        distinct_categories = await _target_categories(session)

    if not distinct_categories:
        log.info("Nothing to backfill (invalidated %d stale cache entries).", invalidated)
        return

    log.info(
        "%sResolving %d distinct category value(s): %s",
        "[DRY-RUN] " if dry_run else "",
        len(distinct_categories),
        sorted(distinct_categories),
    )

    async with SessionLocal() as classify_session:
        resolutions = await resolve_canonical_classes_bulk(distinct_categories, classify_session)

    async with SessionLocal() as session:
        if snapshot_path:
            await _snapshot_target_rows(session, distinct_categories, snapshot_path)

        total_updated = 0
        for raw_category, resolution in resolutions.items():
            result = await session.execute(
                text(
                    "UPDATE features SET attributes = attributes || jsonb_build_object('_canonical_class', CAST(:cls AS text)) "
                    "WHERE category = :cat "
                    "AND (NOT (attributes ? '_canonical_class') OR attributes->>'_canonical_class' = ANY(:stale_classes))"
                ),
                {"cls": resolution.canonical_class, "cat": raw_category, "stale_classes": list(_STALE_SOURCE_CLASSES)},
            )
            log.info(
                "category=%r -> canonical_class=%r (%s, confidence=%.2f) — %d row(s) updated",
                raw_category, resolution.canonical_class, resolution.match_method.value,
                resolution.confidence, result.rowcount,
            )
            total_updated += result.rowcount

        if dry_run:
            await session.rollback()
            log.info("[DRY-RUN] Would update %d feature rows across %d categories; no changes committed.", total_updated, len(resolutions))
        else:
            await session.commit()
            log.info("Backfill complete: %d feature rows updated across %d categories.", total_updated, len(resolutions))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill _canonical_class for unclassified features.")
    parser.add_argument("--dry-run", action="store_true", help="Resolve and log what would change, but commit nothing.")
    parser.add_argument("--snapshot", metavar="PATH", help="Write a JSON snapshot of rows that will be modified (for rollback).")
    parser.add_argument("--restore", metavar="PATH", help="Restore feature attributes from a snapshot written by --snapshot.")
    args = parser.parse_args()
    asyncio.run(main(dry_run=args.dry_run, snapshot_path=args.snapshot, restore_path=args.restore))

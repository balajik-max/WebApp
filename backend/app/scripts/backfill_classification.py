"""One-time backfill for two distinct data-quality gaps found while building
the manhole recommendation engine (see class_taxonomy.py / classification.py
/ gis_reader.py):

1. Rows with NO `_canonical_class` key at all — classification was never
   attempted for them, because of the gdb_layer-fallback bug in
   gis_reader.py._persist() (now fixed for future uploads). Their `category`
   field is already correct (that fallback always worked); only the
   classification input was missing it.
2. Rows explicitly cached as `"Unclassified"` whose raw category is now a
   real synonym of the newly-added Elevation_Contour / Drainage_Level_Point
   classes (e.g. "Contour Line_ Minor" was embedding-scored at 0.55, just
   under the 0.60 threshold, before those classes/synonyms existed). Their
   stale category_class_map cache entry is deleted first so resolution
   re-runs against the current taxonomy instead of returning the old result.

Safe to re-run: (1) only touches rows where the key is genuinely absent;
(2) only invalidates cache entries that exactly match a NEW synonym.

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

# Only these two classes are new since the last time classification ran
# across the whole dataset — restrict cache invalidation to their synonyms
# so we never touch a category that is genuinely, correctly Unclassified.
_NEW_CLASSES = ("Elevation_Contour", "Drainage_Level_Point")


async def _invalidate_stale_unclassified_cache(session, dry_run: bool) -> int:
    new_synonyms = {syn for cls in _NEW_CLASSES for syn in CLASS_SYNONYMS[cls]}
    stale_rows = (
        await session.execute(
            text("SELECT raw_category FROM category_class_map WHERE canonical_class = 'Unclassified'")
        )
    ).scalars().all()
    to_delete = [c for c in stale_rows if normalize_category(c) in new_synonyms]
    if not to_delete:
        return 0
    if dry_run:
        log.info("[DRY-RUN] Would invalidate stale Unclassified cache for: %s", to_delete)
        return len(to_delete)
    await session.execute(
        text("DELETE FROM category_class_map WHERE raw_category = ANY(:cats)"),
        {"cats": to_delete},
    )
    await session.commit()
    log.info("Invalidated stale Unclassified cache for: %s", to_delete)
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
    return {c for c in (*missing_key_rows, *explicit_unclassified_rows) if c and c.strip()}


async def _snapshot_target_rows(session, categories, snapshot_path: str) -> int:
    rows = (
        await session.execute(
            text(
                "SELECT id, attributes FROM features "
                "WHERE category = ANY(:cats) "
                "AND (NOT (attributes ? '_canonical_class') OR attributes->>'_canonical_class' = 'Unclassified')"
            ),
            {"cats": list(categories)},
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
                    "AND (NOT (attributes ? '_canonical_class') OR attributes->>'_canonical_class' = 'Unclassified')"
                ),
                {"cls": resolution.canonical_class, "cat": raw_category},
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

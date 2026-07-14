"""
One-off maintenance script: backfill `_canonical_class` into the attributes
JSONB of every already-ingested feature. New uploads get this written at
ingestion time (see gis_reader.py / table_reader.py); this script exists
purely to catch up rows ingested before the classification service existed,
without requiring every dataset to be deleted and re-uploaded.

Run from the backend/ directory (or via `docker compose exec backend python
backfill_canonical_class.py`):
    python backfill_canonical_class.py
"""
import asyncio
import sys

sys.path.insert(0, ".")


async def main() -> None:
    from sqlalchemy import text

    from app.db.session import SessionLocal
    from app.services.classification import resolve_canonical_classes_bulk

    async with SessionLocal() as session:
        rows = (
            await session.execute(
                text(
                    "SELECT DISTINCT category FROM features "
                    "WHERE category IS NOT NULL AND NOT (attributes ? '_canonical_class')"
                )
            )
        ).scalars().all()
        categories = {r for r in rows if r}
        if not categories:
            print("Nothing to backfill — every feature already has _canonical_class.")
            return

        print(f"Resolving {len(categories)} distinct categories...")
        resolutions = await resolve_canonical_classes_bulk(categories, session)

        total_updated = 0
        for raw_category, resolution in resolutions.items():
            result = await session.execute(
                text(
                    "UPDATE features SET attributes = attributes || "
                    "jsonb_build_object('_canonical_class', CAST(:cls AS text)) "
                    "WHERE category = :raw AND NOT (attributes ? '_canonical_class')"
                ),
                {"cls": resolution.canonical_class, "raw": raw_category},
            )
            print(f"  {raw_category!r:35} -> {resolution.canonical_class:20} ({result.rowcount} rows)")
            total_updated += result.rowcount

        await session.commit()
        print(f"Backfill complete: {total_updated} feature rows updated.")


if __name__ == "__main__":
    asyncio.run(main())

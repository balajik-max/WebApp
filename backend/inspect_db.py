import asyncio
from sqlalchemy import text
from app.db.session import SessionLocal

async def main():
    async with SessionLocal() as db:
        rows = (await db.execute(text(
            "SELECT attributes->>'_canonical_class' AS cc, count(*) FROM features GROUP BY 1 ORDER BY 2 DESC LIMIT 25"
        ))).all()
        print("canonical_class distribution:")
        for r in rows:
            print("   ", r[0], r[1])
        rows2 = (await db.execute(text(
            "SELECT category, count(*) FROM features "
            "WHERE category ILIKE '%manhole%' OR category ILIKE '%access%' OR category ILIKE '%drain%' "
            "GROUP BY 1 ORDER BY 2 DESC LIMIT 25"
        ))).all()
        print("manhole/drain-ish category values:")
        for r in rows2:
            print("   ", r[0], r[1])

asyncio.run(main())

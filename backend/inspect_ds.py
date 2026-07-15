import asyncio
from sqlalchemy import text
from app.db.session import SessionLocal

async def main():
    async with SessionLocal() as db:
        rows = (await db.execute(text(
            "SELECT dataset_id, count(*) FROM features GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
        ))).all()
        print("dataset_id distribution:")
        for r in rows:
            print("   ", r[0], r[1])
        # also confirm the canonical Access_Point rows' dataset_id
        rows2 = (await db.execute(text(
            "SELECT dataset_id, count(*) FROM features WHERE attributes->>'_canonical_class'='Access_Point' GROUP BY 1"
        ))).all()
        print("Access_Point dataset_ids:")
        for r in rows2:
            print("   ", r[0], r[1])

asyncio.run(main())

import asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

async def check():
    pwd = "jvpiLtvqdqqSZ1HdBVEgokQk8Bzww"
    user = "postgres_admin"
    
    for db in ["davangere_auth", "davangere_admin", "davangere_aee"]:
        url = f"postgresql+asyncpg://{user}:{pwd}@192.168.10.81:4594/{db}"
        engine = create_async_engine(url)
        async with engine.connect() as conn:
            result = await conn.execute(
                text("SELECT id, name, status FROM datasets WHERE name LIKE '%Ingestion%' OR name LIKE '%Retry%' LIMIT 5")
            )
            rows = result.fetchall()
            if rows:
                print(f"{db}:")
                for r in rows:
                    print(f"  {r[0]} | {r[1]} | {r[2]}")
            else:
                print(f"{db}: (no matching datasets)")
        await engine.dispose()

asyncio.run(check())

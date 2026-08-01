import asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

async def delete():
    pwd = "jvpiLtvqdqqSZ1HdBVEgokQk8Bzww"
    user = "postgres_admin"
    url = f"postgresql+asyncpg://{user}:{pwd}@192.168.10.81:4594/davangere_admin"
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.execute(
            text("DELETE FROM features WHERE dataset_id = :did"),
            {"did": "e85c51b5-f431-41d2-b594-575787e5ad07"},
        )
        await conn.execute(
            text("DELETE FROM datasets WHERE id = :did"),
            {"did": "e85c51b5-f431-41d2-b594-575787e5ad07"},
        )
        print("Deleted stuck dataset from davangere_admin")
    await engine.dispose()

asyncio.run(delete())
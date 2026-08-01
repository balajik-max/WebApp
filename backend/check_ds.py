import asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

async def check():
    pwd = "jvpiLtvqdqqSZ1HdBVEgokQk8Bzww"
    url = f"postgresql+asyncpg://postgres_admin:{pwd}@192.168.10.81:4594/davangere_admin"
    engine = create_async_engine(url)
    async with engine.connect() as conn:
        result = await conn.execute(
            text("SELECT id, name, status, processing_error FROM datasets ORDER BY created_at DESC LIMIT 3")
        )
        for r in result.fetchall():
            print(f"{r[0]} | {r[1]} | {r[2]} | {r[3]}")
    await engine.dispose()

asyncio.run(check())

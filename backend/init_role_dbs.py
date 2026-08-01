"""Initialize role databases with tables and seed users."""
import asyncio
import uuid
from app.db.base import Base
from app.core.config import get_settings
from app.core.security import hash_password
from app.models import User, UserRole
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import text, select


async def init():
    settings = get_settings()
    role_urls = {
        "admin": (settings.db_admin, UserRole.ADMIN, settings.admin_email, settings.admin_password, settings.admin_name),
        "architect": (settings.db_architect, UserRole.ARCHITECT, settings.architect_email, settings.architect_password, settings.architect_name),
        "commissioner": (settings.db_commissioner, UserRole.COMMISSIONER, settings.commissioner_email, settings.commissioner_password, settings.commissioner_name),
        "aee": (settings.db_aee, UserRole.AEE, settings.aee_email, settings.aee_password, settings.aee_name),
        "ae": (settings.db_ae, UserRole.AE, settings.ae_email, settings.ae_password, settings.ae_name),
        "mla": (settings.db_mla, UserRole.MLA, settings.mla_email, settings.mla_password, settings.mla_name),
    }

    for role, (url, user_role, email, password, name) in role_urls.items():
        if url == settings.database_url:
            continue

        db_name = url.split("/")[-1]
        engine = create_async_engine(url, echo=False)

        # Enable PostGIS
        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))

        # Create tables
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        # Verify
        async with engine.connect() as conn:
            result = await conn.execute(
                text("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
            )
            count = result.scalar()
            print(f"{role} ({db_name}): {count} tables")

        # Seed user using session
        SessionFactory = async_sessionmaker(bind=engine, expire_on_commit=False)
        async with SessionFactory() as session:
            result = await session.execute(select(User).where(User.email == email))
            existing = result.scalar_one_or_none()
            if existing:
                print(f"{role}: user exists, skip")
            else:
                user = User(
                    id=uuid.uuid4(),
                    name=name,
                    email=email,
                    password_hash=hash_password(password),
                    role=user_role,
                    is_active=True,
                )
                session.add(user)
                await session.commit()
                print(f"{role}: user created in {db_name}")

        await engine.dispose()

    print("\nAll role databases initialized!")


if __name__ == "__main__":
    asyncio.run(init())

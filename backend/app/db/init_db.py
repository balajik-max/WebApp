"""
One-shot schema bootstrap + idempotent seed for the two v1 users.

* Creates every ORM table declared under `app.models`.
* Ensures the GIST spatial index on `features.geom` exists with the exact
  name required by the spec (`idx_features_geom`).
* Seeds an admin and an architect user, updating their password hash if
  the value in the environment has changed.
"""
from __future__ import annotations

import logging

from sqlalchemy import select, text

from app.core.config import get_settings
from app.core.security import hash_password, verify_password
from app.db.base import Base
from app.db.session import SessionLocal, engine
from app.models import User, UserRole  # noqa: F401  (import to register all models)
from app.models import (  # noqa: F401
    ActivityLog,
    CategoryClassMap,
    Comment,
    Dataset,
    Feature,
    FeatureVersion,
    Placemark,
    ReviewItem,
    SpatialAnomaly,
    SurveyRequest,
)

log = logging.getLogger("davangere.db.init")


async def _ensure_spatial_index() -> None:
    """Create the named spatial + JSONB indexes required by the spec.

    * `idx_features_geom` — GIST on features.geom for instant viewport filtering.
    * `idx_features_attributes_gin` — GIN on features.attributes for
      unstructured JSONB queries (`?`, `@>`, `#>` operators).
    """
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_features_geom "
                "ON features USING GIST (geom);"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_features_attributes_gin "
                "ON features USING GIN (attributes jsonb_path_ops);"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_spatial_anomalies_geom "
                "ON spatial_anomalies USING GIST (geom);"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_spatial_anomalies_dataset_type_color "
                "ON spatial_anomalies (dataset_id, anomaly_type, color);"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_placemarks_geom "
                "ON placemarks USING GIST (geom);"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_placemarks_owner_updated "
                "ON placemarks (owner_id, updated_at DESC);"
            )
        )


async def _seed_user(session, *, email: str, password: str, name: str, role: UserRole) -> None:
    result = await session.execute(select(User).where(User.email == email))
    existing = result.scalar_one_or_none()
    if existing is None:
        session.add(
            User(
                email=email,
                password_hash=hash_password(password),
                name=name,
                role=role,
            )
        )
        log.info("Seeded %s user %s", role.value, email)
    elif not verify_password(password, existing.password_hash):
        existing.password_hash = hash_password(password)
        log.info("Rotated password for %s", email)


async def init_database() -> None:
    settings = get_settings()

    # 1. Create tables (Alembic handles this in production migrations).
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis;"))
        await conn.run_sync(Base.metadata.create_all)

    # 2. Ensure named spatial index exists (spec requirement).
    await _ensure_spatial_index()

    # 3. Seed v1 users.
    async with SessionLocal() as session:
        await _seed_user(
            session,
            email=settings.admin_email,
            password=settings.admin_password,
            name=settings.admin_name,
            role=UserRole.ADMIN,
        )
        await _seed_user(
            session,
            email=settings.architect_email,
            password=settings.architect_password,
            name=settings.architect_name,
            role=UserRole.ARCHITECT,
        )
        await session.commit()

    log.info("Database initialization complete")

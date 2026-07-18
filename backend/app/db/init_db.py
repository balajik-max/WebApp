"""
One-shot schema bootstrap + idempotent seed for the seeded users.

* Creates every ORM table declared under `app.models`.
* Ensures the GIST spatial index on `features.geom` exists with the exact
  name required by the spec (`idx_features_geom`).
* Seeds the admin, architect and commissioner users, updating their password
  hash if the value in the environment has changed.
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
    CityCensusSummary,
    Comment,
    Dataset,
    Feature,
    FeatureVersion,
    Placemark,
    PointVerification,
    ReviewItem,
    SpatialAnomaly,
    SurveyRequest,
    WardCensus,
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
        # ADMIN POINT VERIFICATION AI GATE V3: additive AI provenance fields for an existing V1 database.
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS anomaly_id UUID;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS detection_mode VARCHAR(16);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS ai_anomaly_type VARCHAR(32);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS ai_color VARCHAR(16);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS ai_severity_score DOUBLE PRECISION;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS ai_detected_at TIMESTAMPTZ;"))
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_point_verifications_anomaly_id "
                "ON point_verifications (anomaly_id);"
            )
        )
        # ARCHITECT REMEDIATION WORKFLOW: additive evidence and Admin-decision fields.
        await conn.execute(text("ALTER TABLE point_verifications ALTER COLUMN verified_by DROP NOT NULL;"))
        await conn.execute(text("ALTER TABLE point_verifications ALTER COLUMN remarks DROP NOT NULL;"))
        await conn.execute(text("ALTER TABLE point_verifications ALTER COLUMN inspected_at DROP NOT NULL;"))
        await conn.execute(text("ALTER TABLE point_verifications ALTER COLUMN issue_summary TYPE VARCHAR(2048);"))
        await conn.execute(text("ALTER TABLE point_verifications ALTER COLUMN remarks TYPE TEXT;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS architect_id UUID REFERENCES users(id) ON DELETE SET NULL;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS work_completed TEXT;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS work_started_at TIMESTAMPTZ;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS work_completed_at TIMESTAMPTZ;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS architect_submitted_at TIMESTAMPTZ;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS evidence_latitude DOUBLE PRECISION;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS evidence_longitude DOUBLE PRECISION;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS evidence_location_source VARCHAR(32);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS evidence_location_status VARCHAR(32);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS evidence_distance_m DOUBLE PRECISION;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS evidence_buffer_m DOUBLE PRECISION;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS before_photo_key VARCHAR(1024);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS before_photo_filename VARCHAR(255);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS before_photo_content_type VARCHAR(128);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS before_photo_exif_latitude DOUBLE PRECISION;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS before_photo_exif_longitude DOUBLE PRECISION;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS before_photo_exif_captured_at TIMESTAMPTZ;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS after_photo_key VARCHAR(1024);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS after_photo_filename VARCHAR(255);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS after_photo_content_type VARCHAR(128);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS after_photo_exif_latitude DOUBLE PRECISION;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS after_photo_exif_longitude DOUBLE PRECISION;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS after_photo_exif_captured_at TIMESTAMPTZ;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS original_condition VARCHAR(128);"))
        await conn.execute(text("ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS verified_condition VARCHAR(32);"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_point_verifications_architect_id ON point_verifications (architect_id);"))
        await conn.execute(text("ALTER TABLE point_verifications DROP CONSTRAINT IF EXISTS point_verifications_feature_id_key;"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_point_verifications_feature_id ON point_verifications (feature_id);"))
        await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_point_verifications_anomaly_id ON point_verifications (anomaly_id) WHERE anomaly_id IS NOT NULL;"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_point_verifications_status_submitted ON point_verifications (status, architect_submitted_at DESC);"))


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

    # 3. Seed application users.
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
        await _seed_user(
            session,
            email=settings.commissioner_email,
            password=settings.commissioner_password,
            name=settings.commissioner_name,
            role=UserRole.COMMISSIONER,
        )
        await _seed_user(
            session,
            email=settings.aee_email,
            password=settings.aee_password,
            name=settings.aee_name,
            role=UserRole.AEE,
        )
        await _seed_user(
            session,
            email=settings.ae_email,
            password=settings.ae_password,
            name=settings.ae_name,
            role=UserRole.AE,
        )
        await session.commit()

    log.info("Database initialization complete")

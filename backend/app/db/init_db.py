"""
One-shot schema bootstrap + idempotent seed for the seeded users.

* Creates every ORM table declared under `app.models`.
* Ensures the GIST spatial index on `features.geom` exists with the exact
  name required by the spec (`idx_features_geom`).
* Seeds the active MLA, Commissioner, AEE and AE users, updating their
  password hash if the value in the environment has changed.
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
        # Workflow notification values evolved after the original schema was
        # deployed. Existing databases may still carry a legacy CHECK constraint
        # that accepts only the old notification values. Merely widening the
        # column does not remove that constraint; an AEE Good decision can then
        # fail while inserting notifications and roll back the whole approval.
        # Drop only CHECK constraints that are attached to notifications.source,
        # convert the column to VARCHAR, remove historical duplicates, and add
        # the current allowed-value constraint plus an idempotency index.
        await conn.execute(
            text(
                """
                DO $$
                DECLARE constraint_name TEXT;
                BEGIN
                    FOR constraint_name IN
                        SELECT c.conname
                        FROM pg_constraint c
                        WHERE c.conrelid = 'notifications'::regclass
                          AND c.contype = 'c'
                          AND pg_get_constraintdef(c.oid) ~* '(^|[^a-zA-Z0-9_])source([^a-zA-Z0-9_]|$)'
                    LOOP
                        EXECUTE format(
                            'ALTER TABLE notifications DROP CONSTRAINT %I',
                            constraint_name
                        );
                    END LOOP;
                END $$;
                """
            )
        )
        await conn.execute(
            text(
                "ALTER TABLE notifications ALTER COLUMN source "
                "TYPE VARCHAR(48) USING source::text;"
            )
        )
        # SQLAlchemy Enum persists Python enum member names by default. Some
        # manually repaired databases may contain the lower-case public values;
        # normalize both formats before applying the canonical constraint.
        await conn.execute(
            text(
                """
                UPDATE notifications
                SET source = CASE source
                    WHEN 'comment_mention' THEN 'COMMENT_MENTION'
                    WHEN 'review_assigned' THEN 'REVIEW_ASSIGNED'
                    WHEN 'review_status_changed' THEN 'REVIEW_STATUS_CHANGED'
                    WHEN 'survey_requested' THEN 'SURVEY_REQUESTED'
                    WHEN 'remediation_submitted' THEN 'REMEDIATION_SUBMITTED'
                    WHEN 'remediation_aee_approved' THEN 'REMEDIATION_AEE_APPROVED'
                    WHEN 'remediation_returned' THEN 'REMEDIATION_RETURNED'
                    WHEN 'remediation_commissioner_accepted' THEN 'REMEDIATION_COMMISSIONER_ACCEPTED'
                    WHEN 'remediation_approved' THEN 'REMEDIATION_APPROVED'
                    WHEN 'remediation_rejected' THEN 'REMEDIATION_REJECTED'
                    ELSE source
                END
                WHERE source IN (
                    'comment_mention',
                    'review_assigned',
                    'review_status_changed',
                    'survey_requested',
                    'remediation_submitted',
                    'remediation_aee_approved',
                    'remediation_returned',
                    'remediation_commissioner_accepted',
                    'remediation_approved',
                    'remediation_rejected'
                );
                """
            )
        )
        await conn.execute(
            text(
                """
                WITH ranked AS (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY user_id, source, source_id
                               ORDER BY created_at DESC, id DESC
                           ) AS duplicate_number
                    FROM notifications
                    WHERE source_id IS NOT NULL
                      AND source IN (
                          'REMEDIATION_SUBMITTED',
                          'REMEDIATION_AEE_APPROVED',
                          'REMEDIATION_RETURNED',
                          'REMEDIATION_COMMISSIONER_ACCEPTED'
                      )
                )
                DELETE FROM notifications n
                USING ranked r
                WHERE n.id = r.id AND r.duplicate_number > 1;
                """
            )
        )
        await conn.execute(text("DROP INDEX IF EXISTS ux_notifications_workflow_event;"))
        await conn.execute(
            text(
                """
                CREATE UNIQUE INDEX ux_notifications_workflow_event
                ON notifications (user_id, source, source_id)
                WHERE source_id IS NOT NULL
                  AND source IN (
                      'REMEDIATION_SUBMITTED',
                      'REMEDIATION_AEE_APPROVED',
                      'REMEDIATION_RETURNED',
                      'REMEDIATION_COMMISSIONER_ACCEPTED'
                  );
                """
            )
        )
        # Keep notifications.source unconstrained for backward compatibility.
        # Older databases can contain historical source values that are no longer
        # members of the current application enum. Recreating a restrictive CHECK
        # here makes startup or AEE approval fail and roll back the transaction.
        # New writes remain validated by SQLAlchemy's NotificationSource enum.
        await conn.execute(text("ALTER TABLE notifications DROP CONSTRAINT IF EXISTS ck_notifications_source;"))

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
        # LEGACY REMEDIATION COMPATIBILITY: preserve historical evidence and decision fields.
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

        # AE -> AEE review -> Commissioner acceptance workflow. Keep role storage as VARCHAR
        # so adding MLA cannot reproduce the native-enum decoding failure.
        await conn.execute(
            text(
                """
                DO $$
                DECLARE role_kind \"char\";
                BEGIN
                    SELECT t.typtype INTO role_kind
                    FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_type t ON t.oid = a.atttypid
                    WHERE c.relname = 'users' AND a.attname = 'role'
                      AND a.attnum > 0 AND NOT a.attisdropped;
                    IF role_kind = 'e' THEN
                        ALTER TABLE users ALTER COLUMN role TYPE VARCHAR(32) USING role::text;
                    END IF;
                END $$;
                """
            )
        )
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;"))
        await conn.execute(
            text(
                "UPDATE users SET role = UPPER(role) "
                "WHERE UPPER(role) IN ('AE','AEE','COMMISSIONER','MLA','ADMIN','ARCHITECT');"
            )
        )
        await conn.execute(text("UPDATE users SET is_active = FALSE WHERE UPPER(role) IN ('ADMIN','ARCHITECT');"))

        canonical_columns = (
            "workflow_status VARCHAR(48)",
            "field_submitter_id UUID",
            "field_submitter_role VARCHAR(32)",
            "ae_name_manual VARCHAR(255)",
            "issue_solved BOOLEAN NOT NULL DEFAULT FALSE",
            "issue_description TEXT",
            "short_description VARCHAR(2048)",
            "field_remarks TEXT",
            "submitted_at TIMESTAMPTZ",
            "aee_id UUID",
            "aee_name_manual VARCHAR(255)",
            "aee_category VARCHAR(16)",
            "aee_decided_at TIMESTAMPTZ",
            "aee_remarks TEXT",
            "commissioner_decision VARCHAR(16)",
            "commissioner_id UUID",
            "commissioner_decided_at TIMESTAMPTZ",
            "commissioner_remarks TEXT",
            "original_ai_condition VARCHAR(16)",
            "current_condition VARCHAR(16)",
            "gps_validation_status VARCHAR(64)",
            "submission_version INTEGER NOT NULL DEFAULT 0",
            "workflow_history JSONB NOT NULL DEFAULT '[]'::jsonb",
        )
        for definition in canonical_columns:
            await conn.execute(text(f"ALTER TABLE point_verifications ADD COLUMN IF NOT EXISTS {definition};"))

        await conn.execute(
            text(
                """
                DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'point_verifications_field_submitter_id_fkey') THEN
                        ALTER TABLE point_verifications ADD CONSTRAINT point_verifications_field_submitter_id_fkey
                            FOREIGN KEY (field_submitter_id) REFERENCES users(id) ON DELETE SET NULL;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'point_verifications_aee_id_fkey') THEN
                        ALTER TABLE point_verifications ADD CONSTRAINT point_verifications_aee_id_fkey
                            FOREIGN KEY (aee_id) REFERENCES users(id) ON DELETE SET NULL;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'point_verifications_commissioner_id_fkey') THEN
                        ALTER TABLE point_verifications ADD CONSTRAINT point_verifications_commissioner_id_fkey
                            FOREIGN KEY (commissioner_id) REFERENCES users(id) ON DELETE SET NULL;
                    END IF;
                END $$;
                """
            )
        )

        # Preserve compatible historical evidence while moving the previous
        # direct-to-Commissioner workflow into the new AE -> AEE chain.
        await conn.execute(
            text(
                """
                UPDATE point_verifications pv
                SET field_submitter_id = pv.architect_id,
                    field_submitter_role = 'ae',
                    submitted_at = COALESCE(pv.architect_submitted_at, pv.updated_at),
                    short_description = COALESCE(NULLIF(BTRIM(pv.work_completed), ''), NULLIF(BTRIM(pv.issue_summary), '')),
                    ae_name_manual = COALESCE(pv.ae_name_manual, u.name)
                FROM users u
                WHERE u.id = pv.architect_id
                  AND UPPER(u.role) = 'AE'
                  AND pv.field_submitter_id IS NULL;
                """
            )
        )
        await conn.execute(
            text(
                """
                UPDATE point_verifications
                SET original_ai_condition = CASE
                        WHEN UPPER(ai_color) IN ('RED','YELLOW','GREEN') THEN UPPER(ai_color)
                        ELSE original_ai_condition END,
                    gps_validation_status = CASE
                        WHEN evidence_location_status = 'photo_exif_verified' THEN 'PHOTO_EXIF_VERIFIED'
                        ELSE COALESCE(gps_validation_status, 'NOT_VALIDATED') END
                WHERE original_ai_condition IS NULL OR gps_validation_status IS NULL;
                """
            )
        )
        await conn.execute(text("ALTER TABLE point_verifications DROP CONSTRAINT IF EXISTS ck_point_verifications_workflow_status;"))
        await conn.execute(
            text(
                """
                UPDATE point_verifications
                SET workflow_status = CASE
                    WHEN workflow_status = 'APPROVED_RESOLVED' THEN 'COMMISSIONER_ACCEPTED'
                    WHEN workflow_status = 'PENDING_COMMISSIONER_APPROVAL' THEN 'PENDING_AEE_APPROVAL'
                    WHEN workflow_status = 'REJECTED_BY_COMMISSIONER' THEN 'RETURNED_BY_AEE'
                    WHEN workflow_status IN ('AI_DETECTED','WORK_IN_PROGRESS','PENDING_AEE_APPROVAL','RETURNED_BY_AEE','AEE_APPROVED','COMMISSIONER_ACCEPTED')
                        THEN workflow_status
                    WHEN UPPER(status) = 'WORK_IN_PROGRESS' AND field_submitter_id IS NOT NULL THEN 'WORK_IN_PROGRESS'
                    WHEN UPPER(status) IN ('RESOLVED','APPROVED_RESOLVED') THEN 'COMMISSIONER_ACCEPTED'
                    WHEN UPPER(status) IN ('PENDING_ADMIN','PENDING_COMMISSIONER_APPROVAL') THEN 'PENDING_AEE_APPROVAL'
                    WHEN UPPER(status) IN ('REJECTED','REJECTED_BY_COMMISSIONER') THEN 'RETURNED_BY_AEE'
                    ELSE 'AI_DETECTED' END;
                """
            )
        )
        await conn.execute(
            text(
                """
                UPDATE point_verifications
                SET issue_solved = workflow_status IN ('PENDING_AEE_APPROVAL','RETURNED_BY_AEE','AEE_APPROVED','COMMISSIONER_ACCEPTED'),
                    current_condition = CASE
                        WHEN workflow_status IN ('AEE_APPROVED','COMMISSIONER_ACCEPTED') THEN 'GOOD'
                        ELSE original_ai_condition END,
                    aee_category = CASE
                        WHEN workflow_status IN ('AEE_APPROVED','COMMISSIONER_ACCEPTED') THEN COALESCE(aee_category, 'GOOD')
                        ELSE aee_category END;
                """
            )
        )
        await conn.execute(text("ALTER TABLE point_verifications ALTER COLUMN workflow_status SET DEFAULT 'AI_DETECTED';"))
        await conn.execute(text("ALTER TABLE point_verifications ALTER COLUMN workflow_status SET NOT NULL;"))
        await conn.execute(
            text(
                """
                DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_point_verifications_workflow_status') THEN
                        ALTER TABLE point_verifications ADD CONSTRAINT ck_point_verifications_workflow_status
                        CHECK (workflow_status IN ('AI_DETECTED','WORK_IN_PROGRESS','PENDING_AEE_APPROVAL','RETURNED_BY_AEE','AEE_APPROVED','COMMISSIONER_ACCEPTED')) NOT VALID;
                    END IF;
                END $$;
                """
            )
        )
        await conn.execute(text("ALTER TABLE point_verifications VALIDATE CONSTRAINT ck_point_verifications_workflow_status;"))
        await conn.execute(text("DROP INDEX IF EXISTS ux_point_verifications_one_active_feature;"))
        await conn.execute(
            text(
                """
                CREATE UNIQUE INDEX ux_point_verifications_one_active_feature
                ON point_verifications (feature_id)
                WHERE workflow_status IN ('WORK_IN_PROGRESS','PENDING_AEE_APPROVAL','RETURNED_BY_AEE','AEE_APPROVED','COMMISSIONER_ACCEPTED');
                """
            )
        )
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_point_verifications_workflow_queue ON point_verifications (workflow_status, submitted_at DESC);"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_point_verifications_aee_id ON point_verifications (aee_id);"))


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
    if existing is not None:
        existing.name = name
        existing.role = role
        existing.is_active = True


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
            email=settings.mla_email,
            password=settings.mla_password,
            name=settings.mla_name,
            role=UserRole.MLA,
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

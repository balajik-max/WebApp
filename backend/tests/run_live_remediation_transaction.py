"""Transactional integration proof for direct AE/AEE remediation.

Run inside the backend container. All database mutations use one outer
transaction that is always rolled back, and object-storage calls are replaced
with an in-memory stub, so existing survey rows and MinIO objects are unchanged.
"""
from __future__ import annotations

import asyncio
import io
from contextlib import ExitStack
from copy import deepcopy
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from PIL import Image
from PIL.TiffImagePlugin import IFDRational
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import Headers

from app.api.v1 import point_verifications as workflow
from app.db.session import engine
from app.models import Feature, PointVerification, SpatialAnomaly, User, UserRole
from app.models.spatial_anomaly import AnomalyColor
from app.schemas.point_verification import CommissionerDecisionIn, FieldSubmissionIn, StartWorkIn


def _dms(value: float) -> tuple[IFDRational, IFDRational, IFDRational]:
    absolute = abs(value)
    degrees = int(absolute)
    minutes_float = (absolute - degrees) * 60
    minutes = int(minutes_float)
    seconds = (minutes_float - minutes) * 60
    return IFDRational(degrees, 1), IFDRational(minutes, 1), IFDRational(round(seconds * 1_000_000), 1_000_000)


def _jpeg(name: str, latitude: float | None = None, longitude: float | None = None) -> UploadFile:
    payload = io.BytesIO()
    image = Image.new("RGB", (24, 24), color=(24, 128, 96))
    exif = Image.Exif()
    if latitude is not None and longitude is not None:
        exif[34853] = {
            1: "N" if latitude >= 0 else "S",
            2: _dms(latitude),
            3: "E" if longitude >= 0 else "W",
            4: _dms(longitude),
        }
    image.save(payload, format="JPEG", exif=exif)
    payload.seek(0)
    return UploadFile(
        file=payload,
        filename=name,
        headers=Headers({"content-type": "image/jpeg"}),
    )


async def _eligible(session: AsyncSession, limit: int = 2) -> list[tuple[Feature, SpatialAnomaly, str]]:
    anomalies = (
        await session.execute(
            select(SpatialAnomaly)
            .where(SpatialAnomaly.color.in_([AnomalyColor.RED, AnomalyColor.YELLOW]))
            .order_by(SpatialAnomaly.created_at.desc())
        )
    ).scalars().all()
    found: list[tuple[Feature, SpatialAnomaly, str]] = []
    for anomaly in anomalies:
        feature_id = workflow._primary_feature_id(anomaly)
        if feature_id is None:
            continue
        existing = (
            await session.execute(
                select(PointVerification.id).where(
                    (PointVerification.feature_id == feature_id)
                    | (PointVerification.anomaly_id == anomaly.id)
                )
            )
        ).first()
        if existing:
            continue
        feature = (await session.execute(select(Feature).where(Feature.id == feature_id))).scalar_one_or_none()
        if feature is None:
            continue
        mode = {
            "pole_redundancy": "poles",
            "drain_encroachment": "drains",
            "manhole_status": "manholes",
        }.get(anomaly.anomaly_type.value)
        if mode:
            found.append((feature, anomaly, mode))
        if len(found) == limit:
            return found
    raise RuntimeError(f"Need {limit} eligible Red/Yellow findings without an existing workflow")


async def _active_user(session: AsyncSession, role: UserRole) -> User:
    return (
        await session.execute(select(User).where(User.role == role, User.is_active.is_(True)).limit(1))
    ).scalar_one()


async def _noop_upload(*_args: object, **_kwargs: object) -> None:
    return None


async def _noop_delete(*_args: object, **_kwargs: object) -> None:
    return None


async def main() -> None:
    async with engine.connect() as connection:
        outer = await connection.begin()
        session = AsyncSession(bind=connection, expire_on_commit=False)
        initial_count = 0
        try:
            initial_count = int((await session.execute(select(func.count(PointVerification.id)))).scalar_one())
            active_roles = set((await session.execute(select(User.role).where(User.is_active.is_(True)))).scalars())
            assert active_roles == {UserRole.AE, UserRole.AEE, UserRole.COMMISSIONER, UserRole.MLA}
            assert not ({UserRole.ADMIN, UserRole.ARCHITECT} & active_roles)
            column_names = set((await session.execute(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'point_verifications'"
            ))).scalars())
            assert {
                "assigned_to_id", "assigned_by_id", "priority", "target_completion_date",
                "contractor_details", "material_quantity_details", "aee_decision", "workflow_history",
                "field_submitter_id", "commissioner_id", "workflow_status",
            }.issubset(column_names)
            assert (await session.execute(text(
                "SELECT 1 FROM pg_constraint WHERE conname = 'ck_point_verifications_workflow_status'"
            ))).scalar_one() == 1
            indexes = set((await session.execute(text(
                "SELECT indexname FROM pg_indexes WHERE tablename = 'point_verifications'"
            ))).scalars())
            assert {"ux_point_verifications_one_active_feature", "ix_point_verifications_workflow_queue"}.issubset(indexes)

            ae = await _active_user(session, UserRole.AE)
            aee = await _active_user(session, UserRole.AEE)
            commissioner = await _active_user(session, UserRole.COMMISSIONER)
            (feature, anomaly, mode), (aee_feature, aee_anomaly, aee_mode) = await _eligible(session)
            original_attributes = deepcopy(feature.attributes)
            original_geometry = bytes(feature.geom.data)
            anomaly_lon, anomaly_lat = (
                await session.execute(
                    select(
                        text("ST_X(geom)"),
                        text("ST_Y(geom)"),
                    ).select_from(SpatialAnomaly).where(SpatialAnomaly.id == anomaly.id)
                )
            ).one()
            aee_lon, aee_lat = (
                await session.execute(
                    select(
                        text("ST_X(geom)"),
                        text("ST_Y(geom)"),
                    ).select_from(SpatialAnomaly).where(SpatialAnomaly.id == aee_anomaly.id)
                )
            ).one()

            with ExitStack() as stack:
                stack.enter_context(patch.object(workflow, "upload_stream", _noop_upload))
                stack.enter_context(patch.object(workflow, "delete_object", _noop_delete))

                context = StartWorkIn(anomaly_id=anomaly.id, detection_mode=mode)  # type: ignore[arg-type]
                started = await workflow.start_work(feature.id, context, ae, session)
                assert started.workflow_status.value == "WORK_IN_PROGRESS"
                assert started.field_submitter_role == "ae"

                try:
                    await workflow.start_work(feature.id, context, aee, session)
                except HTTPException as exc:
                    assert exc.status_code == 409
                else:
                    raise AssertionError("Competing Start Work did not return HTTP 409")

                try:
                    await workflow.upload_evidence(
                        feature.id, anomaly.id, mode, _jpeg("before.jpg", anomaly_lat, anomaly_lon),
                        _jpeg("after-no-gps.jpg"), ae, session,
                    )
                except HTTPException as exc:
                    assert exc.status_code == 422 and "no GPS metadata" in str(exc.detail)
                else:
                    raise AssertionError("Missing After-image GPS was accepted")

                try:
                    await workflow.upload_evidence(
                        feature.id, anomaly.id, mode, _jpeg("before.jpg", anomaly_lat, anomaly_lon),
                        _jpeg("after-far.jpg", anomaly_lat + 1.0, anomaly_lon + 1.0), ae, session,
                    )
                except HTTPException as exc:
                    assert exc.status_code == 422 and "allowed distance" in str(exc.detail)
                else:
                    raise AssertionError("Out-of-buffer GPS was accepted")

                evidence = await workflow.upload_evidence(
                    feature.id, anomaly.id, mode, _jpeg("before.jpg", anomaly_lat, anomaly_lon),
                    _jpeg("after.jpg", anomaly_lat, anomaly_lon), ae, session,
                )
                assert evidence.gps_validation_status == "PHOTO_EXIF_VERIFIED"
                assert evidence.evidence_buffer_m == {"poles": 15.0, "manholes": 15.0, "drains": 30.0}[mode]

                pending = await workflow.submit_to_commissioner(
                    feature.id,
                    FieldSubmissionIn(
                        anomaly_id=anomaly.id,
                        detection_mode=mode,  # type: ignore[arg-type]
                        issue_solved=True,
                        short_description="Transactional field remediation proof",
                        remarks="First submission",
                    ),
                    ae,
                    session,
                )
                assert pending.workflow_status.value == "PENDING_COMMISSIONER_APPROVAL"
                assert pending.current_condition == pending.original_ai_condition

                rejected = await workflow.commissioner_decision(
                    feature.id,
                    CommissionerDecisionIn(anomaly_id=anomaly.id, decision="REJECT", reason="Correction proof"),
                    commissioner,
                    session,
                )
                assert rejected.workflow_status.value == "REJECTED_BY_COMMISSIONER"
                first_evidence_urls = [(item.before_photo_url, item.after_photo_url) for item in rejected.history if item.event == "EVIDENCE_UPLOADED"]
                assert first_evidence_urls and all(first_evidence_urls[0])

                restarted = await workflow.start_work(feature.id, context, ae, session)
                assert restarted.workflow_status.value == "WORK_IN_PROGRESS"
                await workflow.upload_evidence(
                    feature.id, anomaly.id, mode, _jpeg("before-v2.jpg", anomaly_lat, anomaly_lon),
                    _jpeg("after-v2.jpg", anomaly_lat, anomaly_lon), ae, session,
                )
                await workflow.submit_to_commissioner(
                    feature.id,
                    FieldSubmissionIn(
                        anomaly_id=anomaly.id,
                        detection_mode=mode,  # type: ignore[arg-type]
                        issue_solved=True,
                        short_description="Corrected transactional remediation proof",
                    ),
                    ae,
                    session,
                )
                approved = await workflow.commissioner_decision(
                    feature.id,
                    CommissionerDecisionIn(anomaly_id=anomaly.id, decision="APPROVE"),
                    commissioner,
                    session,
                )
                assert approved.workflow_status.value == "APPROVED_RESOLVED"
                assert approved.current_condition == "GOOD"
                assert len([item for item in approved.history if item.event == "EVIDENCE_UPLOADED"]) == 2

                aee_context = StartWorkIn(anomaly_id=aee_anomaly.id, detection_mode=aee_mode)  # type: ignore[arg-type]
                aee_started = await workflow.start_work(aee_feature.id, aee_context, aee, session)
                assert aee_started.field_submitter_role == "aee"
                await workflow.upload_evidence(
                    aee_feature.id, aee_anomaly.id, aee_mode,
                    _jpeg("aee-before.jpg", aee_lat, aee_lon), _jpeg("aee-after.jpg", aee_lat, aee_lon),
                    aee, session,
                )
                aee_pending = await workflow.submit_to_commissioner(
                    aee_feature.id,
                    FieldSubmissionIn(
                        anomaly_id=aee_anomaly.id,
                        detection_mode=aee_mode,  # type: ignore[arg-type]
                        issue_solved=True,
                        short_description="AEE direct submission proof",
                    ),
                    aee,
                    session,
                )
                assert aee_pending.workflow_status.value == "PENDING_COMMISSIONER_APPROVAL"

            refreshed = (await session.execute(select(Feature).where(Feature.id == feature.id))).scalar_one()
            assert refreshed.attributes == original_attributes
            assert bytes(refreshed.geom.data) == original_geometry
        finally:
            await session.close()
            await outer.rollback()
            post_rollback_count = int((await connection.execute(select(func.count(PointVerification.id)))).scalar_one())
            assert post_rollback_count == initial_count
            await connection.rollback()
            await engine.dispose()
    print("PASS: additive migration, four active roles, rolled-back AE/AEE direct workflow, 409 locking, GPS gates, rejection/resubmission, Commissioner approval, immutable GDB feature")


if __name__ == "__main__":
    asyncio.run(main())

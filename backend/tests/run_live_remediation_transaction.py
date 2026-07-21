"""Rollback-only integration proof for AE -> AEE -> Commissioner remediation."""
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
from app.models import Feature, Notification, NotificationSource, PointVerification, SpatialAnomaly, User, UserRole
from app.models.spatial_anomaly import AnomalyColor
from app.schemas.point_verification import AeeDecisionIn, CommissionerAcceptanceIn, FieldSubmissionIn, StartWorkIn


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
    return UploadFile(file=payload, filename=name, headers=Headers({"content-type": "image/jpeg"}))


async def _eligible(session: AsyncSession) -> tuple[Feature, SpatialAnomaly, str]:
    anomalies = (
        await session.execute(
            select(SpatialAnomaly)
            .where(SpatialAnomaly.color.in_([AnomalyColor.RED, AnomalyColor.YELLOW]))
            .order_by(SpatialAnomaly.created_at.desc())
        )
    ).scalars().all()
    for anomaly in anomalies:
        feature_id = workflow._primary_feature_id(anomaly)
        if feature_id is None:
            continue
        existing = (
            await session.execute(
                select(PointVerification.id).where(
                    (PointVerification.feature_id == feature_id) | (PointVerification.anomaly_id == anomaly.id)
                )
            )
        ).first()
        if existing:
            continue
        feature = (await session.execute(select(Feature).where(Feature.id == feature_id))).scalar_one_or_none()
        mode = {
            "pole_redundancy": "poles",
            "drain_encroachment": "drains",
            "manhole_status": "manholes",
        }.get(anomaly.anomaly_type.value)
        if feature is not None and mode:
            return feature, anomaly, mode
    raise RuntimeError("Need one eligible Red/Yellow finding without an existing workflow")


async def _active_user(session: AsyncSession, role: UserRole) -> User:
    return (
        await session.execute(select(User).where(User.role == role, User.is_active.is_(True)).limit(1))
    ).scalar_one()


async def _noop(*_args: object, **_kwargs: object) -> None:
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

            columns = set((await session.execute(text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'point_verifications'"
            ))).scalars())
            assert {
                "workflow_status", "field_submitter_id", "ae_name_manual", "issue_description",
                "aee_id", "aee_name_manual", "aee_category", "aee_decided_at", "aee_remarks",
                "commissioner_id", "workflow_history",
            }.issubset(columns)

            ae = await _active_user(session, UserRole.AE)
            aee = await _active_user(session, UserRole.AEE)
            commissioner = await _active_user(session, UserRole.COMMISSIONER)
            feature, anomaly, mode = await _eligible(session)
            original_attributes = deepcopy(feature.attributes)
            original_geometry = bytes(feature.geom.data)
            lon, lat = (
                await session.execute(
                    select(text("ST_X(geom)"), text("ST_Y(geom)")).select_from(SpatialAnomaly).where(SpatialAnomaly.id == anomaly.id)
                )
            ).one()

            with ExitStack() as stack:
                stack.enter_context(patch.object(workflow, "upload_stream", _noop))
                stack.enter_context(patch.object(workflow, "delete_object", _noop))

                context = StartWorkIn(anomaly_id=anomaly.id, detection_mode=mode)  # type: ignore[arg-type]
                started = await workflow.start_work(feature.id, context, ae, session)
                assert started.workflow_status.value == "WORK_IN_PROGRESS"
                assert started.field_submitter_role == "ae"

                try:
                    await workflow.upload_evidence(
                        feature.id, anomaly.id, mode,
                        _jpeg("before.jpg", lat, lon), _jpeg("after-no-gps.jpg"), ae, session,
                    )
                except HTTPException as exc:
                    assert exc.status_code == 422 and "no GPS metadata" in str(exc.detail)
                else:
                    raise AssertionError("Missing After-image GPS was accepted")

                await workflow.upload_evidence(
                    feature.id, anomaly.id, mode,
                    _jpeg("before.jpg", lat, lon), _jpeg("after.jpg", lat, lon), ae, session,
                )
                pending = await workflow.submit_to_aee(
                    feature.id,
                    FieldSubmissionIn(
                        anomaly_id=anomaly.id,
                        detection_mode=mode,  # type: ignore[arg-type]
                        ae_name="Contract AE One",
                        issue_description="Blocked field asset",
                        work_completed="Blockage removed and flow restored",
                        remarks="First submission",
                    ),
                    ae,
                    session,
                )
                assert pending.workflow_status.value == "PENDING_AEE_APPROVAL"
                assert pending.ae_name == "Contract AE One"
                assert int((await session.execute(
                    select(func.count(Notification.id)).where(
                        Notification.source_id == pending.id,
                        Notification.source == NotificationSource.REMEDIATION_SUBMITTED,
                    )
                )).scalar_one()) >= 1

                returned = await workflow.aee_decision(
                    feature.id,
                    AeeDecisionIn(
                        anomaly_id=anomaly.id,
                        aee_name="Contract AEE One",
                        category="MODERATE",
                        remarks="Upload a clearer completed-work image",
                    ),
                    aee,
                    session,
                )
                assert returned.workflow_status.value == "RETURNED_BY_AEE"
                assert returned.current_condition == returned.original_ai_condition
                assert int((await session.execute(
                    select(func.count(Notification.id)).where(
                        Notification.source_id == returned.id,
                        Notification.source == NotificationSource.REMEDIATION_RETURNED,
                    )
                )).scalar_one()) >= 1

                restarted = await workflow.start_work(feature.id, context, ae, session)
                assert restarted.workflow_status.value == "WORK_IN_PROGRESS"
                assert restarted.ae_name is None
                assert restarted.aee_name is None
                await workflow.upload_evidence(
                    feature.id, anomaly.id, mode,
                    _jpeg("before-v2.jpg", lat, lon), _jpeg("after-v2.jpg", lat, lon), ae, session,
                )
                await workflow.submit_to_aee(
                    feature.id,
                    FieldSubmissionIn(
                        anomaly_id=anomaly.id,
                        detection_mode=mode,  # type: ignore[arg-type]
                        ae_name="Contract AE Two",
                        issue_description="Blocked field asset",
                        work_completed="Corrected work completed and documented",
                    ),
                    ae,
                    session,
                )
                approved = await workflow.aee_decision(
                    feature.id,
                    AeeDecisionIn(
                        anomaly_id=anomaly.id,
                        aee_name="Contract AEE Two",
                        category="GOOD",
                        remarks="Verified as complete",
                    ),
                    aee,
                    session,
                )
                assert approved.workflow_status.value == "AEE_APPROVED"
                assert approved.current_condition == "GOOD"
                assert approved.aee_name == "Contract AEE Two"
                assert len([item for item in approved.history if item.event == "EVIDENCE_UPLOADED"]) == 2
                assert int((await session.execute(
                    select(func.count(Notification.id)).where(
                        Notification.source_id == approved.id,
                        Notification.source == NotificationSource.REMEDIATION_AEE_APPROVED,
                    )
                )).scalar_one()) >= 2

                accepted = await workflow.commissioner_accept(
                    feature.id,
                    CommissionerAcceptanceIn(anomaly_id=anomaly.id, remarks="Accepted"),
                    commissioner,
                    session,
                )
                assert accepted.workflow_status.value == "COMMISSIONER_ACCEPTED"
                assert accepted.current_condition == "GOOD"
                assert accepted.commissioner_name == commissioner.name
                assert int((await session.execute(
                    select(func.count(Notification.id)).where(
                        Notification.source_id == accepted.id,
                        Notification.source == NotificationSource.REMEDIATION_COMMISSIONER_ACCEPTED,
                    )
                )).scalar_one()) >= 2

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
    print("PASS: AE field work, AEE Moderate return, correction/resubmission, AEE Good approval/Blue, Commissioner acceptance, notifications, GPS gates, immutable GDB feature")


if __name__ == "__main__":
    asyncio.run(main())

"""Compatibility API for the colleague's Architect -> Admin remediation flow.

The new operational workflow is AE -> AEE -> Commissioner.  These endpoints
remain available so existing Architect/Admin users, historical records, and
external clients are not broken.  The removed Tasks/Activity localStorage
assignment feature is deliberately not restored here.
"""
from __future__ import annotations

import io
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.api.deps import require_admin, require_any, require_architect
from app.core.config import get_settings
from app.db.session import get_db
from app.models import (
    ActivityAction,
    ActivityLog,
    Feature,
    Notification,
    NotificationSource,
    PointVerification,
    SpatialAnomaly,
    User,
    UserRole,
)
from app.models.point_verification import (
    PointVerificationStatus,
    RemediationWorkflowStatus,
    VerifiedCondition,
)
from app.models.spatial_anomaly import AnomalyColor, AnomalyStatus, AnomalyType
from app.schemas.point_verification import (
    DetectionMode,
    LegacyAdminDecisionIn,
    LegacyPointVerificationOut,
)
from app.services.storage import delete_object, upload_stream

router = APIRouter()

_MODE_TO_ANOMALY: dict[str, AnomalyType] = {
    "poles": AnomalyType.POLE_REDUNDANCY,
    "drains": AnomalyType.DRAIN_ENCROACHMENT,
    "manholes": AnomalyType.MANHOLE_STATUS,
}
_SETTINGS = get_settings()
_BUFFER_BY_MODE: dict[str, float] = {
    "poles": _SETTINGS.remediation_pole_buffer_m,
    "drains": _SETTINGS.remediation_drain_buffer_m,
    "manholes": _SETTINGS.remediation_manhole_buffer_m,
}
_ELIGIBLE_AI_COLORS = {AnomalyColor.RED, AnomalyColor.YELLOW}
_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
_ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
_MAX_IMAGE_BYTES = _SETTINGS.remediation_max_image_mb * 1024 * 1024
_NEW_ACTIVE = {
    RemediationWorkflowStatus.WORK_IN_PROGRESS,
    RemediationWorkflowStatus.PENDING_AEE_APPROVAL,
    RemediationWorkflowStatus.RETURNED_BY_AEE,
    RemediationWorkflowStatus.AEE_APPROVED,
    RemediationWorkflowStatus.COMMISSIONER_ACCEPTED,
}


def _text_value(value: object) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def _condition(attributes: dict) -> str | None:
    return _text_value(attributes.get("Condition") or attributes.get("condition"))


def _source_layer(feature: Feature) -> str | None:
    attributes = feature.attributes or {}
    return _text_value(attributes.get("gdb_layer") or attributes.get("LAYER") or feature.category)


def _primary_feature_id(anomaly: SpatialAnomaly) -> uuid.UUID | None:
    metadata = anomaly.anomaly_metadata or {}
    raw = (
        metadata.get("this_feature_id")
        or metadata.get("building_id")
        or metadata.get("manhole_id")
        or (anomaly.feature_ids[0] if anomaly.feature_ids else None)
    )
    if raw is None:
        return None
    try:
        return raw if isinstance(raw, uuid.UUID) else uuid.UUID(str(raw))
    except (TypeError, ValueError):
        return None


def _rational_to_float(value: object) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        numerator = getattr(value, "numerator", 0)
        denominator = getattr(value, "denominator", 1) or 1
        return float(numerator) / float(denominator)


def _gps_coordinate(values: object, ref: object) -> float | None:
    if not isinstance(values, (tuple, list)) or len(values) < 3:
        return None
    coordinate = (
        _rational_to_float(values[0])
        + _rational_to_float(values[1]) / 60.0
        + _rational_to_float(values[2]) / 3600.0
    )
    if isinstance(ref, bytes):
        ref = ref.decode("ascii", errors="ignore")
    if str(ref).strip().upper() in {"S", "W"}:
        coordinate *= -1
    return coordinate


def _parse_exif_datetime(value: object) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(str(value), "%Y:%m:%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _extract_image_metadata(payload: bytes) -> tuple[float | None, float | None, datetime | None]:
    # Import locally so this compatibility module does not make application
    # startup depend on Pillow unless the existing workflow is actually used.
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(payload)) as image:
            image.verify()
        with Image.open(io.BytesIO(payload)) as image:
            exif = image.getexif()
            captured_at = _parse_exif_datetime(exif.get(36867) or exif.get(306))
            gps = exif.get_ifd(34853) if 34853 in exif else None
            if not gps:
                return None, None, captured_at
            return _gps_coordinate(gps.get(2), gps.get(1)), _gps_coordinate(gps.get(4), gps.get(3)), captured_at
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="The uploaded file is not a valid supported image") from exc


def _safe_filename(filename: str | None, fallback: str) -> str:
    raw = Path(filename or fallback).name
    cleaned = "".join(char if char.isalnum() or char in {".", "-", "_"} else "_" for char in raw)
    return cleaned[:180] or fallback


async def _read_image(
    file: UploadFile,
    label: str,
) -> tuple[bytes, str, str, float | None, float | None, datetime | None]:
    filename = _safe_filename(file.filename, f"{label}.jpg")
    suffix = Path(filename).suffix.lower()
    content_type = (file.content_type or "").lower()
    if content_type not in _ALLOWED_IMAGE_TYPES or suffix not in _ALLOWED_IMAGE_SUFFIXES:
        raise HTTPException(status_code=422, detail=f"{label} photo must be JPG, JPEG, PNG, or WebP")
    payload = await file.read(_MAX_IMAGE_BYTES + 1)
    if not payload:
        raise HTTPException(status_code=422, detail=f"{label} photo is empty")
    if len(payload) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail=f"{label} photo exceeds the configured upload limit")
    lat, lon, captured_at = _extract_image_metadata(payload)
    return payload, filename, content_type, lat, lon, captured_at


async def _load_feature(db: AsyncSession, feature_id: uuid.UUID, *, lock: bool = False) -> Feature:
    stmt = select(Feature).options(joinedload(Feature.dataset)).where(Feature.id == feature_id)
    if lock:
        stmt = stmt.with_for_update(of=Feature)
    feature = (await db.execute(stmt)).unique().scalar_one_or_none()
    if feature is None:
        raise HTTPException(status_code=404, detail="Survey feature not found")
    return feature


async def _load_verification(
    db: AsyncSession,
    feature_id: uuid.UUID,
    anomaly_id: uuid.UUID | None = None,
    *,
    lock: bool = False,
) -> PointVerification | None:
    stmt = select(PointVerification).where(PointVerification.feature_id == feature_id)
    if anomaly_id is not None:
        stmt = stmt.where(PointVerification.anomaly_id == anomaly_id)
    stmt = stmt.order_by(PointVerification.updated_at.desc()).limit(1)
    if lock:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def _load_anomaly(db: AsyncSession, anomaly_id: uuid.UUID, *, lock: bool = False) -> SpatialAnomaly:
    stmt = select(SpatialAnomaly).where(SpatialAnomaly.id == anomaly_id)
    if lock:
        stmt = stmt.with_for_update()
    anomaly = (await db.execute(stmt)).scalar_one_or_none()
    if anomaly is None:
        raise HTTPException(status_code=404, detail="AI detection result was not found. Run AI Detection again.")
    return anomaly


def _validate_ai_candidate(feature: Feature, anomaly: SpatialAnomaly, detection_mode: DetectionMode) -> None:
    if anomaly.dataset_id != feature.dataset_id:
        raise HTTPException(status_code=422, detail="The AI result does not belong to this dataset")
    if anomaly.anomaly_type != _MODE_TO_ANOMALY[detection_mode]:
        raise HTTPException(status_code=422, detail="The selected AI mode does not match this detected issue")
    if anomaly.color not in _ELIGIBLE_AI_COLORS:
        raise HTTPException(status_code=422, detail="Only AI-detected Red or Yellow issues can enter remediation")
    if _primary_feature_id(anomaly) != feature.id:
        raise HTTPException(status_code=422, detail="The selected feature is not the primary feature for this AI result")


async def _distance_to_anomaly(
    db: AsyncSession,
    anomaly_id: uuid.UUID,
    latitude: float,
    longitude: float,
) -> float:
    result = await db.execute(
        text(
            """
            SELECT ST_DistanceSphere(geom, ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326))
            FROM spatial_anomalies WHERE id = :anomaly_id
            """
        ),
        {"anomaly_id": anomaly_id, "latitude": latitude, "longitude": longitude},
    )
    distance = result.scalar_one_or_none()
    if distance is None:
        raise HTTPException(status_code=404, detail="AI finding geometry was not found")
    return float(distance)


async def _user_name(db: AsyncSession, user_id: uuid.UUID | None) -> str | None:
    if user_id is None:
        return None
    return (await db.execute(select(User.name).where(User.id == user_id))).scalar_one_or_none()


def _photo_url(row: PointVerification, kind: str, key: str | None) -> str | None:
    return f"/api/v1/point-verifications/evidence/{row.id}/{kind}" if key else None


def _status_value(row: PointVerification | None) -> PointVerificationStatus | None:
    if row is None:
        return None
    raw = row.status.value if isinstance(row.status, PointVerificationStatus) else str(row.status)
    normalized = raw.strip().lower()
    try:
        return PointVerificationStatus(normalized)
    except ValueError:
        return PointVerificationStatus.OPEN


async def _to_out(
    db: AsyncSession,
    feature: Feature,
    row: PointVerification | None,
    anomaly: SpatialAnomaly | None = None,
    detection_mode: DetectionMode | None = None,
) -> LegacyPointVerificationOut:
    active = row if not (anomaly is not None and row is not None and row.anomaly_id != anomaly.id) else None
    architect_name = await _user_name(db, active.architect_id) if active else None
    verified_by_name = await _user_name(db, active.verified_by) if active else None
    status = _status_value(active)
    survey_condition = _condition(feature.attributes or {})
    original_condition = active.original_condition if active and active.original_condition else survey_condition
    verified_condition = active.verified_condition if active else None
    current_condition = (
        verified_condition.value.title()
        if active and status == PointVerificationStatus.RESOLVED and verified_condition
        else survey_condition
    )
    longitude = latitude = None
    target_anomaly = anomaly
    if target_anomaly is None and active and active.anomaly_id:
        target_anomaly = await _load_anomaly(db, active.anomaly_id)
    if target_anomaly is not None:
        longitude, latitude = (
            await db.execute(
                select(func.ST_X(SpatialAnomaly.geom), func.ST_Y(SpatialAnomaly.geom)).where(
                    SpatialAnomaly.id == target_anomaly.id
                )
            )
        ).one()

    return LegacyPointVerificationOut(
        id=active.id if active else None,
        feature_id=feature.id,
        dataset_id=feature.dataset_id,
        dataset_name=feature.dataset.name,
        label=feature.label,
        category=feature.category,
        source_layer=_source_layer(feature),
        survey_condition=survey_condition,
        original_condition=original_condition,
        verified_condition=verified_condition,
        current_condition=current_condition,
        survey_issue=target_anomaly is not None or active is not None,
        status=status if active else (PointVerificationStatus.OPEN if target_anomaly else None),
        issue_fixed=active.issue_fixed if active else None,
        architect_id=active.architect_id if active else None,
        architect_name=architect_name,
        issue_summary=active.issue_summary if active else None,
        work_completed=active.work_completed if active else None,
        work_started_at=active.work_started_at if active else None,
        work_completed_at=active.work_completed_at if active else None,
        architect_submitted_at=active.architect_submitted_at if active else None,
        evidence_latitude=active.evidence_latitude if active else None,
        evidence_longitude=active.evidence_longitude if active else None,
        evidence_location_source=active.evidence_location_source if active else None,
        evidence_location_status=active.evidence_location_status if active else None,
        evidence_distance_m=active.evidence_distance_m if active else None,
        evidence_buffer_m=active.evidence_buffer_m if active else None,
        before_photo_url=_photo_url(active, "before", active.before_photo_key) if active else None,
        before_photo_filename=active.before_photo_filename if active else None,
        before_photo_exif_latitude=active.before_photo_exif_latitude if active else None,
        before_photo_exif_longitude=active.before_photo_exif_longitude if active else None,
        before_photo_exif_captured_at=active.before_photo_exif_captured_at if active else None,
        after_photo_url=_photo_url(active, "after", active.after_photo_key) if active else None,
        after_photo_filename=active.after_photo_filename if active else None,
        after_photo_exif_latitude=active.after_photo_exif_latitude if active else None,
        after_photo_exif_longitude=active.after_photo_exif_longitude if active else None,
        after_photo_exif_captured_at=active.after_photo_exif_captured_at if active else None,
        remarks=active.remarks if active else None,
        inspected_at=active.inspected_at if active else None,
        resolved_at=active.resolved_at if active else None,
        rejected_at=active.rejected_at if active else None,
        verified_by_id=active.verified_by if active else None,
        verified_by_name=verified_by_name,
        anomaly_id=active.anomaly_id if active else (target_anomaly.id if target_anomaly else None),
        detection_mode=active.detection_mode if active else detection_mode,
        ai_anomaly_type=active.ai_anomaly_type if active else (target_anomaly.anomaly_type.value if target_anomaly else None),
        ai_color=active.ai_color if active else (target_anomaly.color.value if target_anomaly else None),
        ai_severity_score=active.ai_severity_score if active else (target_anomaly.severity_score if target_anomaly else None),
        ai_detected_at=active.ai_detected_at if active else (target_anomaly.created_at if target_anomaly else None),
        longitude=longitude,
        latitude=latitude,
        created_at=active.created_at if active else None,
        updated_at=active.updated_at if active else None,
    )


async def _notify_admins(db: AsyncSession, row: PointVerification, architect: User, feature: Feature) -> None:
    admin_ids = (await db.execute(select(User.id).where(User.role == UserRole.ADMIN))).scalars().all()
    for admin_id in admin_ids:
        db.add(
            Notification(
                user_id=admin_id,
                actor_id=architect.id,
                source=NotificationSource.REMEDIATION_SUBMITTED,
                source_id=row.id,
                feature_id=feature.id,
                message=f"{architect.name} submitted AI remediation evidence for {feature.label or feature.category or feature.id}.",
            )
        )


async def _notify_architect(db: AsyncSession, row: PointVerification, admin: User, approved: bool) -> None:
    if row.architect_id is None:
        return
    condition = row.verified_condition.value.title() if row.verified_condition else "Not recorded"
    message = (
        f"{admin.name} approved your remediation. Current condition: {condition}."
        if approved
        else f"{admin.name} denied the approval. Condition: {condition}. Reason: {(row.remarks or 'Correction required').strip()}"
    )
    db.add(
        Notification(
            user_id=row.architect_id,
            actor_id=admin.id,
            source=NotificationSource.REMEDIATION_APPROVED if approved else NotificationSource.REMEDIATION_REJECTED,
            source_id=row.id,
            feature_id=row.feature_id,
            message=message[:1024],
        )
    )


def _assert_not_operational(row: PointVerification | None) -> None:
    if row is None:
        return
    if row.field_submitter_id is not None and row.workflow_status in _NEW_ACTIVE:
        raise HTTPException(
            status_code=409,
            detail="This AI issue is already being handled in the AE/AEE/Commissioner workflow.",
        )


@router.get(
    "/legacy/by-id/{verification_id}",
    response_model=LegacyPointVerificationOut,
    dependencies=[Depends(require_any)],
    summary="Read one exact historical Architect/Admin remediation record",
)
async def get_legacy_by_id(
    verification_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> LegacyPointVerificationOut:
    row = (
        await db.execute(select(PointVerification).where(PointVerification.id == verification_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="This remediation item no longer exists.")
    feature = await _load_feature(db, row.feature_id)
    anomaly = await _load_anomaly(db, row.anomaly_id) if row.anomaly_id else None
    return await _to_out(db, feature, row, anomaly, row.detection_mode)


@router.post(
    "/{feature_id}/architect-submit",
    response_model=LegacyPointVerificationOut,
    summary="Architect submits remediation details and geotagged photo evidence",
)
async def architect_submit(
    feature_id: uuid.UUID,
    anomaly_id: uuid.UUID = Form(...),
    detection_mode: DetectionMode = Form(...),
    issue_summary: str = Form(..., min_length=3, max_length=2048),
    work_completed: str = Form(..., min_length=3, max_length=10000),
    work_started_at: datetime | None = Form(default=None),
    work_completed_at: datetime = Form(...),
    before_photo: UploadFile = File(...),
    after_photo: UploadFile = File(...),
    architect: User = Depends(require_architect),
    db: AsyncSession = Depends(get_db),
) -> LegacyPointVerificationOut:
    now = datetime.now(timezone.utc)
    if work_completed_at.tzinfo is None:
        work_completed_at = work_completed_at.replace(tzinfo=timezone.utc)
    if work_started_at and work_started_at.tzinfo is None:
        work_started_at = work_started_at.replace(tzinfo=timezone.utc)
    if work_started_at and work_completed_at < work_started_at:
        raise HTTPException(status_code=422, detail="Work completion time cannot be earlier than work start time")
    if work_completed_at > now.replace(microsecond=0):
        raise HTTPException(status_code=422, detail="Work completion time cannot be in the future")

    feature = await _load_feature(db, feature_id, lock=True)
    anomaly = await _load_anomaly(db, anomaly_id, lock=True)
    _validate_ai_candidate(feature, anomaly, detection_mode)
    existing = await _load_verification(db, feature_id, anomaly.id, lock=True)
    _assert_not_operational(existing)
    status = _status_value(existing)
    if status == PointVerificationStatus.RESOLVED:
        raise HTTPException(status_code=409, detail="This AI finding is already Admin-approved")
    if status == PointVerificationStatus.PENDING_ADMIN:
        raise HTTPException(status_code=409, detail="This remediation is already waiting for Admin verification")

    buffer_m = _BUFFER_BY_MODE[detection_mode]
    before = await _read_image(before_photo, "Before")
    after = await _read_image(after_photo, "After")
    after_lat, after_lon = after[3], after[4]
    if after_lat is None or after_lon is None:
        raise HTTPException(status_code=422, detail="After-work photo has no GPS metadata. Upload the original geotagged camera image.")
    if not (-90 <= after_lat <= 90) or not (-180 <= after_lon <= 180):
        raise HTTPException(status_code=422, detail="After-work photo contains invalid GPS coordinates")
    after_distance = await _distance_to_anomaly(db, anomaly.id, after_lat, after_lon)
    if after_distance > buffer_m:
        raise HTTPException(status_code=422, detail=f"After-work photo GPS is {after_distance:.1f} m from the AI point; allowed buffer is {buffer_m:.0f} m")

    before_lat, before_lon = before[3], before[4]
    before_has_gps = before_lat is not None and before_lon is not None
    if before_has_gps:
        if not (-90 <= before_lat <= 90) or not (-180 <= before_lon <= 180):
            raise HTTPException(status_code=422, detail="Before-work photo contains invalid GPS coordinates")
        before_distance = await _distance_to_anomaly(db, anomaly.id, before_lat, before_lon)
        if before_distance > buffer_m:
            raise HTTPException(status_code=422, detail=f"Before-work photo GPS is {before_distance:.1f} m from the AI point; allowed buffer is {buffer_m:.0f} m")

    if existing is None:
        existing = PointVerification(
            id=uuid.uuid4(),
            feature_id=feature.id,
            status=PointVerificationStatus.OPEN.value,
            workflow_status=RemediationWorkflowStatus.AI_DETECTED,
            workflow_history=[],
        )
        db.add(existing)
    base_key = f"remediation/{feature.dataset_id}/{anomaly.id}/{existing.id}/legacy"
    before_key = f"{base_key}/before-{uuid.uuid4().hex[:10]}-{before[1]}"
    after_key = f"{base_key}/after-{uuid.uuid4().hex[:10]}-{after[1]}"
    uploaded_keys: list[str] = []
    try:
        await upload_stream(io.BytesIO(before[0]), key=before_key, content_type=before[2])
        uploaded_keys.append(before_key)
        await upload_stream(io.BytesIO(after[0]), key=after_key, content_type=after[2])
        uploaded_keys.append(after_key)

        existing.status = PointVerificationStatus.PENDING_ADMIN.value
        existing.workflow_status = RemediationWorkflowStatus.AI_DETECTED
        existing.issue_fixed = False
        existing.original_condition = existing.original_condition or _condition(feature.attributes or {})
        existing.verified_condition = None
        existing.architect_id = architect.id
        existing.issue_summary = issue_summary.strip()
        existing.work_completed = work_completed.strip()
        existing.work_started_at = work_started_at
        existing.work_completed_at = work_completed_at
        existing.architect_submitted_at = now
        existing.evidence_latitude = after_lat
        existing.evidence_longitude = after_lon
        existing.evidence_location_source = "before_and_after_photo_exif" if before_has_gps else "after_photo_exif"
        existing.evidence_location_status = "photo_exif_verified"
        existing.evidence_distance_m = after_distance
        existing.evidence_buffer_m = buffer_m
        existing.before_photo_key = before_key
        existing.before_photo_filename = before[1]
        existing.before_photo_content_type = before[2]
        existing.before_photo_exif_latitude = before[3]
        existing.before_photo_exif_longitude = before[4]
        existing.before_photo_exif_captured_at = before[5]
        existing.after_photo_key = after_key
        existing.after_photo_filename = after[1]
        existing.after_photo_content_type = after[2]
        existing.after_photo_exif_latitude = after[3]
        existing.after_photo_exif_longitude = after[4]
        existing.after_photo_exif_captured_at = after[5]
        existing.remarks = None
        existing.inspected_at = None
        existing.resolved_at = None
        existing.rejected_at = None
        existing.verified_by = None
        existing.anomaly_id = anomaly.id
        existing.detection_mode = detection_mode
        existing.ai_anomaly_type = anomaly.anomaly_type.value
        existing.ai_color = anomaly.color.value
        existing.ai_severity_score = anomaly.severity_score
        existing.ai_detected_at = anomaly.created_at
        anomaly.status = AnomalyStatus.REVIEWING

        attributes = dict(feature.attributes or {})
        attributes.update(
            {
                "_verification_status": PointVerificationStatus.PENDING_ADMIN.value,
                "_verification_issue_fixed": False,
                "_verification_anomaly_id": str(anomaly.id),
                "_verification_detection_mode": detection_mode,
                "_verification_original_condition": existing.original_condition,
                "_verification_architect": architect.name,
            }
        )
        for key in (
            "_verification_resolved_at",
            "_verification_verified_by",
            "_verification_verified_condition",
            "_verification_current_condition",
            "_verification_admin_assessed_condition",
        ):
            attributes.pop(key, None)
        feature.attributes = attributes
        await db.flush()
        db.add(
            ActivityLog(
                actor_id=architect.id,
                action=ActivityAction.ARCHITECT_REMEDIATION_SUBMITTED,
                entity_type="point_verification",
                entity_id=existing.id,
                payload={
                    "feature_id": str(feature.id),
                    "dataset_id": str(feature.dataset_id),
                    "anomaly_id": str(anomaly.id),
                    "detection_mode": detection_mode,
                    "status": PointVerificationStatus.PENDING_ADMIN.value,
                    "latitude": after_lat,
                    "longitude": after_lon,
                    "distance_m": round(after_distance, 3),
                    "buffer_m": buffer_m,
                    "location_status": existing.evidence_location_status,
                },
            )
        )
        await _notify_admins(db, existing, architect, feature)
        await db.flush()
    except Exception:
        for key in uploaded_keys:
            try:
                await delete_object(key)
            except Exception:
                pass
        raise

    return await _to_out(db, feature, existing, anomaly, detection_mode)


@router.post(
    "/{feature_id}/admin-decision",
    response_model=LegacyPointVerificationOut,
    summary="Admin approves or rejects Architect remediation evidence",
)
async def admin_decision(
    feature_id: uuid.UUID,
    body: LegacyAdminDecisionIn,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> LegacyPointVerificationOut:
    feature = await _load_feature(db, feature_id, lock=True)
    anomaly = await _load_anomaly(db, body.anomaly_id, lock=True)
    _validate_ai_candidate(feature, anomaly, body.detection_mode)
    row = await _load_verification(db, feature_id, anomaly.id, lock=True)
    if row is None or row.anomaly_id != anomaly.id:
        raise HTTPException(status_code=404, detail="Architect remediation submission was not found")
    _assert_not_operational(row)
    status = _status_value(row)
    if status == PointVerificationStatus.RESOLVED:
        raise HTTPException(status_code=409, detail="This AI finding is already Admin-approved")
    if status != PointVerificationStatus.PENDING_ADMIN:
        raise HTTPException(status_code=409, detail="This remediation is not waiting for Admin verification")
    if not row.before_photo_key or not row.after_photo_key or not row.architect_submitted_at:
        raise HTTPException(status_code=422, detail="Required Architect evidence is incomplete")

    now = datetime.now(timezone.utc)
    approved = body.decision == "approve"
    row.status = (PointVerificationStatus.RESOLVED if approved else PointVerificationStatus.REJECTED).value
    row.workflow_status = RemediationWorkflowStatus.AI_DETECTED
    row.issue_fixed = approved
    row.original_condition = row.original_condition or _condition(feature.attributes or {})
    row.verified_condition = body.verified_condition
    row.remarks = body.remarks.strip()
    row.inspected_at = now
    row.resolved_at = now if approved else None
    row.rejected_at = None if approved else now
    row.verified_by = admin.id
    anomaly.status = AnomalyStatus.RESOLVED if approved else AnomalyStatus.REVIEWING

    attributes = dict(feature.attributes or {})
    attributes.update(
        {
            "_verification_status": row.status,
            "_verification_issue_fixed": approved,
            "_verification_inspected_at": now.isoformat(),
            "_verification_remarks": row.remarks,
            "_verification_verified_by": admin.name,
            "_verification_anomaly_id": str(anomaly.id),
            "_verification_detection_mode": body.detection_mode,
            "_verification_ai_type": anomaly.anomaly_type.value,
            "_verification_ai_color": anomaly.color.value,
            "_verification_ai_severity": anomaly.severity_score,
            "_verification_original_condition": row.original_condition,
            "_verification_admin_assessed_condition": body.verified_condition.value.title(),
        }
    )
    if approved:
        attributes["_verification_resolved_at"] = now.isoformat()
        attributes["_verification_verified_condition"] = body.verified_condition.value.title()
        attributes["_verification_current_condition"] = body.verified_condition.value.title()
    else:
        for key in ("_verification_resolved_at", "_verification_verified_condition", "_verification_current_condition"):
            attributes.pop(key, None)
    feature.attributes = attributes

    await db.flush()
    db.add(
        ActivityLog(
            actor_id=admin.id,
            action=ActivityAction.ADMIN_REMEDIATION_DECIDED,
            entity_type="point_verification",
            entity_id=row.id,
            payload={
                "feature_id": str(feature.id),
                "dataset_id": str(feature.dataset_id),
                "anomaly_id": str(anomaly.id),
                "decision": body.decision,
                "verified_condition": body.verified_condition.value,
                "original_condition": row.original_condition,
                "status": row.status,
                "remarks": row.remarks,
            },
        )
    )
    await _notify_architect(db, row, admin, approved)
    return await _to_out(db, feature, row, anomaly, body.detection_mode)


# Keep this dynamic compatibility route last.  The module is included after
# the new router, so static /updates, /inbox and /export paths remain higher
# priority and cannot be swallowed by UUID validation.
@router.get(
    "/{feature_id}",
    response_model=LegacyPointVerificationOut,
    dependencies=[Depends(require_any)],
    summary="View legacy Architect/Admin remediation state",
)
async def get_point_verification(
    feature_id: uuid.UUID,
    anomaly_id: uuid.UUID = Query(...),
    detection_mode: DetectionMode = Query(...),
    db: AsyncSession = Depends(get_db),
) -> LegacyPointVerificationOut:
    feature = await _load_feature(db, feature_id)
    anomaly = await _load_anomaly(db, anomaly_id)
    _validate_ai_candidate(feature, anomaly, detection_mode)
    row = await _load_verification(db, feature_id, anomaly.id)
    return await _to_out(db, feature, row, anomaly, detection_mode)

"""Architect remediation evidence and Admin approval for AI-detected issues."""
from __future__ import annotations

import io
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from PIL import Image, UnidentifiedImageError
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin, require_any, require_architect
from app.core.config import get_settings
from app.db.session import get_db
from app.models import (
    ActivityAction,
    ActivityLog,
    Dataset,
    Feature,
    Notification,
    NotificationSource,
    PointVerification,
    PointVerificationStatus,
    SpatialAnomaly,
    User,
    UserRole,
    VerifiedCondition,
)
from app.models.spatial_anomaly import AnomalyColor, AnomalyStatus, AnomalyType
from app.schemas.point_verification import (
    AdminDecisionIn,
    DetectionMode,
    PointVerificationOut,
    RemediationInboxItem,
    RemediationUpdateItem,
)
from app.services.resolved_gdb_export import ResolvedGdbRecord, generate_resolved_gdb
from app.services.storage import delete_object, get_object_bytes, upload_stream

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


def _text_value(value: object) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def _excel_datetime(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    return str(value)


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
        return float(value)  # Pillow IFDRational supports float().
    except (TypeError, ValueError):
        numerator = getattr(value, "numerator", 0)
        denominator = getattr(value, "denominator", 1) or 1
        return float(numerator) / float(denominator)


def _gps_coordinate(values: object, ref: object) -> float | None:
    if not isinstance(values, (tuple, list)) or len(values) < 3:
        return None
    degrees = _rational_to_float(values[0])
    minutes = _rational_to_float(values[1])
    seconds = _rational_to_float(values[2])
    coordinate = degrees + minutes / 60.0 + seconds / 3600.0
    if isinstance(ref, bytes):
        ref = ref.decode("ascii", errors="ignore")
    if str(ref).strip().upper() in {"S", "W"}:
        coordinate *= -1
    return coordinate


def _parse_exif_datetime(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.strptime(str(value), "%Y:%m:%d %H:%M:%S")
        return parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _extract_image_metadata(payload: bytes) -> tuple[float | None, float | None, datetime | None]:
    try:
        with Image.open(io.BytesIO(payload)) as image:
            image.verify()
        with Image.open(io.BytesIO(payload)) as image:
            exif = image.getexif()
            captured_at = _parse_exif_datetime(exif.get(36867) or exif.get(306))
            gps = exif.get_ifd(34853) if 34853 in exif else None
            if not gps:
                return None, None, captured_at
            latitude = _gps_coordinate(gps.get(2), gps.get(1))
            longitude = _gps_coordinate(gps.get(4), gps.get(3))
            return latitude, longitude, captured_at
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=422, detail="The uploaded file is not a valid supported image")


def _safe_filename(filename: str | None, fallback: str) -> str:
    raw = Path(filename or fallback).name
    cleaned = "".join(char if char.isalnum() or char in {".", "-", "_"} else "_" for char in raw)
    return cleaned[:180] or fallback


async def _read_image(file: UploadFile, label: str) -> tuple[bytes, str, str, float | None, float | None, datetime | None]:
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
    exif_lat, exif_lon, captured_at = _extract_image_metadata(payload)
    return payload, filename, content_type, exif_lat, exif_lon, captured_at


async def _load_feature(db: AsyncSession, feature_id: uuid.UUID) -> Feature:
    feature = (await db.execute(select(Feature).where(Feature.id == feature_id))).scalar_one_or_none()
    if feature is None:
        raise HTTPException(status_code=404, detail="Survey feature not found")
    return feature


async def _load_verification(
    db: AsyncSession,
    feature_id: uuid.UUID,
    anomaly_id: uuid.UUID | None = None,
) -> PointVerification | None:
    stmt = select(PointVerification).where(PointVerification.feature_id == feature_id)
    if anomaly_id is not None:
        stmt = stmt.where(PointVerification.anomaly_id == anomaly_id)
    stmt = stmt.order_by(PointVerification.updated_at.desc()).limit(1)
    return (await db.execute(stmt)).scalar_one_or_none()


async def _load_ai_anomaly(db: AsyncSession, anomaly_id: uuid.UUID) -> SpatialAnomaly:
    anomaly = (
        await db.execute(select(SpatialAnomaly).where(SpatialAnomaly.id == anomaly_id))
    ).scalar_one_or_none()
    if anomaly is None:
        raise HTTPException(status_code=404, detail="AI detection result was not found. Run AI Detection again.")
    return anomaly


def _validate_ai_candidate(feature: Feature, anomaly: SpatialAnomaly, detection_mode: DetectionMode) -> None:
    expected_type = _MODE_TO_ANOMALY[detection_mode]
    if anomaly.dataset_id != feature.dataset_id:
        raise HTTPException(status_code=422, detail="The AI result does not belong to this dataset")
    if anomaly.anomaly_type != expected_type:
        raise HTTPException(status_code=422, detail="The selected AI mode does not match this detected issue")
    if anomaly.color not in _ELIGIBLE_AI_COLORS:
        raise HTTPException(status_code=422, detail="Only AI-detected red or yellow issues can enter remediation")
    if _primary_feature_id(anomaly) != feature.id:
        raise HTTPException(status_code=422, detail="The selected feature is not the primary feature for this AI result")


async def _distance_to_anomaly(db: AsyncSession, anomaly_id: uuid.UUID, latitude: float, longitude: float) -> float:
    result = await db.execute(
        text(
            """
            SELECT ST_DistanceSphere(
                geom,
                ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)
            )
            FROM spatial_anomalies
            WHERE id = :anomaly_id
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
    if not key:
        return None
    return f"/api/v1/point-verifications/evidence/{row.id}/{kind}"


async def _to_out(
    db: AsyncSession,
    feature: Feature,
    row: PointVerification | None,
    anomaly: SpatialAnomaly | None = None,
    detection_mode: DetectionMode | None = None,
) -> PointVerificationOut:
    active_row = row
    if anomaly is not None and row is not None and row.anomaly_id != anomaly.id:
        active_row = None

    architect_name = await _user_name(db, active_row.architect_id) if active_row else None
    verified_by_name = await _user_name(db, active_row.verified_by) if active_row else None

    anomaly_id = active_row.anomaly_id if active_row else (anomaly.id if anomaly else None)
    mode = active_row.detection_mode if active_row else detection_mode
    ai_type = active_row.ai_anomaly_type if active_row else (anomaly.anomaly_type.value if anomaly else None)
    ai_color = active_row.ai_color if active_row else (anomaly.color.value if anomaly else None)
    ai_score = active_row.ai_severity_score if active_row else (anomaly.severity_score if anomaly else None)
    ai_detected_at = active_row.ai_detected_at if active_row else (anomaly.created_at if anomaly else None)
    survey_condition = _condition(feature.attributes or {})
    original_condition = active_row.original_condition if active_row and active_row.original_condition else survey_condition
    verified_condition = active_row.verified_condition if active_row else None
    current_condition = (
        verified_condition.value.title()
        if active_row and active_row.status == PointVerificationStatus.RESOLVED and verified_condition
        else survey_condition
    )

    return PointVerificationOut(
        id=active_row.id if active_row else None,
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
        survey_issue=anomaly is not None or active_row is not None,
        status=active_row.status if active_row else (PointVerificationStatus.OPEN if anomaly else None),
        issue_fixed=active_row.issue_fixed if active_row else None,
        architect_id=active_row.architect_id if active_row else None,
        architect_name=architect_name,
        issue_summary=active_row.issue_summary if active_row else None,
        work_completed=active_row.work_completed if active_row else None,
        work_started_at=active_row.work_started_at if active_row else None,
        work_completed_at=active_row.work_completed_at if active_row else None,
        architect_submitted_at=active_row.architect_submitted_at if active_row else None,
        evidence_latitude=active_row.evidence_latitude if active_row else None,
        evidence_longitude=active_row.evidence_longitude if active_row else None,
        evidence_location_source=active_row.evidence_location_source if active_row else None,
        evidence_location_status=active_row.evidence_location_status if active_row else None,
        evidence_distance_m=active_row.evidence_distance_m if active_row else None,
        evidence_buffer_m=active_row.evidence_buffer_m if active_row else None,
        before_photo_url=_photo_url(active_row, "before", active_row.before_photo_key) if active_row else None,
        before_photo_filename=active_row.before_photo_filename if active_row else None,
        before_photo_exif_latitude=active_row.before_photo_exif_latitude if active_row else None,
        before_photo_exif_longitude=active_row.before_photo_exif_longitude if active_row else None,
        before_photo_exif_captured_at=active_row.before_photo_exif_captured_at if active_row else None,
        after_photo_url=_photo_url(active_row, "after", active_row.after_photo_key) if active_row else None,
        after_photo_filename=active_row.after_photo_filename if active_row else None,
        after_photo_exif_latitude=active_row.after_photo_exif_latitude if active_row else None,
        after_photo_exif_longitude=active_row.after_photo_exif_longitude if active_row else None,
        after_photo_exif_captured_at=active_row.after_photo_exif_captured_at if active_row else None,
        remarks=active_row.remarks if active_row else None,
        inspected_at=active_row.inspected_at if active_row else None,
        resolved_at=active_row.resolved_at if active_row else None,
        rejected_at=active_row.rejected_at if active_row else None,
        verified_by_id=active_row.verified_by if active_row else None,
        verified_by_name=verified_by_name,
        anomaly_id=anomaly_id,
        detection_mode=mode,
        ai_anomaly_type=ai_type,
        ai_color=ai_color,
        ai_severity_score=ai_score,
        ai_detected_at=ai_detected_at,
        created_at=active_row.created_at if active_row else None,
        updated_at=active_row.updated_at if active_row else None,
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
    if approved:
        message = f"{admin.name} approved your remediation. Current condition: {condition}."
    else:
        reason = (row.remarks or "Correction required").strip()
        message = f"{admin.name} denied the approval. Condition: {condition}. Reason: {reason}"
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


@router.get(
    "/inbox",
    response_model=list[RemediationInboxItem],
    summary="Admin remediation queue",
)
async def remediation_inbox(
    status_filter: PointVerificationStatus = Query(default=PointVerificationStatus.PENDING_ADMIN),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[RemediationInboxItem]:
    del admin
    rows = (
        await db.execute(
            select(PointVerification, Feature, User.name)
            .join(Feature, Feature.id == PointVerification.feature_id)
            .outerjoin(User, User.id == PointVerification.architect_id)
            .where(PointVerification.status == status_filter)
            .order_by(PointVerification.architect_submitted_at.desc().nullslast())
        )
    ).all()
    return [
        RemediationInboxItem(
            verification_id=verification.id,
            feature_id=feature.id,
            dataset_id=feature.dataset_id,
            dataset_name=feature.dataset.name,
            label=feature.label,
            category=feature.category,
            status=verification.status,
            detection_mode=verification.detection_mode,
            ai_color=verification.ai_color,
            architect_name=architect_name,
            issue_summary=verification.issue_summary,
            work_completed_at=verification.work_completed_at,
            architect_submitted_at=verification.architect_submitted_at,
            evidence_location_status=verification.evidence_location_status,
            evidence_distance_m=verification.evidence_distance_m,
        )
        for verification, feature, architect_name in rows
    ]


@router.get(
    "/export.xlsx",
    dependencies=[Depends(require_any)],
    summary="Download the remediation register as a color-coded Excel workbook",
)
async def export_point_verifications(
    dataset_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> Response:
    params: dict[str, object] = {}
    dataset_filter = ""
    if dataset_id is not None:
        dataset_filter = "AND f.dataset_id = :dataset_id"
        params["dataset_id"] = dataset_id

    rows = (
        await db.execute(
            text(
                f"""
                SELECT
                    pv.id::text AS verification_id,
                    f.id::text AS feature_id,
                    d.name AS dataset_name,
                    f.label,
                    f.category,
                    f.attributes,
                    f.created_at AS survey_recorded_at,
                    pv.status,
                    pv.original_condition,
                    pv.verified_condition,
                    pv.issue_summary,
                    pv.work_completed,
                    pv.work_started_at,
                    pv.work_completed_at,
                    pv.architect_submitted_at,
                    pv.evidence_latitude,
                    pv.evidence_longitude,
                    pv.evidence_location_source,
                    pv.evidence_location_status,
                    pv.evidence_distance_m,
                    pv.evidence_buffer_m,
                    pv.before_photo_filename,
                    pv.after_photo_filename,
                    pv.inspected_at,
                    pv.resolved_at,
                    pv.rejected_at,
                    pv.remarks,
                    pv.anomaly_id::text AS anomaly_id,
                    pv.detection_mode,
                    pv.ai_anomaly_type,
                    pv.ai_color,
                    pv.ai_severity_score,
                    pv.ai_detected_at,
                    architect.name AS architect_name,
                    admin.name AS admin_name
                FROM point_verifications pv
                JOIN features f ON f.id = pv.feature_id
                JOIN datasets d ON d.id = f.dataset_id
                LEFT JOIN users architect ON architect.id = pv.architect_id
                LEFT JOIN users admin ON admin.id = pv.verified_by
                WHERE pv.anomaly_id IS NOT NULL
                  {dataset_filter}
                ORDER BY d.name, pv.ai_detected_at, pv.updated_at, f.id
                """
            ),
            params,
        )
    ).mappings().all()

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "AI Remediation Register"
    headers = [
        "Feature ID", "Dataset", "Layer", "Label", "Original Condition", "Verified Condition",
        "Current Condition", "AI Mode", "AI Finding", "AI Original Color", "AI Severity",
        "AI Detected Date", "Issue Description",
        "Architect", "Work Started", "Work Completed Date", "Work Completed Details",
        "Submission Date", "Evidence Latitude", "Evidence Longitude", "Location Source",
        "Location Status", "Distance (m)", "Allowed Buffer (m)", "Before Photo", "After Photo",
        "Workflow Status", "Admin", "Admin Review Date", "Resolution Date", "Rejection Date",
        "Admin Remarks", "Survey Date", "X_LONG / Easting", "Y_LAT / Northing",
    ]
    sheet.append(headers)

    header_fill = PatternFill("solid", fgColor="0F766E")
    header_font = Font(color="FFFFFF", bold=True)
    fills = {
        PointVerificationStatus.RESOLVED.value: PatternFill("solid", fgColor="5B9BD5"),
        PointVerificationStatus.PENDING_ADMIN.value: PatternFill("solid", fgColor="FCE4A6"),
        PointVerificationStatus.REJECTED.value: PatternFill("solid", fgColor="F4CCCC"),
        "yellow": PatternFill("solid", fgColor="FFF2CC"),
        "red": PatternFill("solid", fgColor="F4CCCC"),
    }
    for cell in sheet[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for row in rows:
        attributes = row["attributes"] or {}
        status_value = row["status"] or PointVerificationStatus.OPEN.value
        layer = _text_value(attributes.get("gdb_layer") or attributes.get("LAYER") or row["category"])
        condition = row["original_condition"] or _condition(attributes)
        verified_condition = row["verified_condition"]
        current_condition = (
            str(verified_condition).title()
            if status_value == PointVerificationStatus.RESOLVED.value and verified_condition
            else condition
        )
        feature_ref = _text_value(attributes.get("FID") or attributes.get("OBJECTID")) or row["feature_id"]
        before_link = f"/api/v1/point-verifications/evidence/{row['verification_id']}/before" if row["before_photo_filename"] else None
        after_link = f"/api/v1/point-verifications/evidence/{row['verification_id']}/after" if row["after_photo_filename"] else None
        values = [
            feature_ref, row["dataset_name"], layer, row["label"], condition,
            str(verified_condition).title() if verified_condition else None, current_condition, row["detection_mode"],
            row["ai_anomaly_type"], row["ai_color"], row["ai_severity_score"],
            _excel_datetime(row["ai_detected_at"]), row["issue_summary"], row["architect_name"],
            _excel_datetime(row["work_started_at"]), _excel_datetime(row["work_completed_at"]),
            row["work_completed"], _excel_datetime(row["architect_submitted_at"]),
            row["evidence_latitude"], row["evidence_longitude"], row["evidence_location_source"],
            row["evidence_location_status"], row["evidence_distance_m"], row["evidence_buffer_m"],
            before_link, after_link, status_value, row["admin_name"], _excel_datetime(row["inspected_at"]),
            _excel_datetime(row["resolved_at"]), _excel_datetime(row["rejected_at"]), row["remarks"],
            _excel_datetime(row["survey_recorded_at"]), attributes.get("X_Long"), attributes.get("Y_Lat"),
        ]
        sheet.append(values)
        fill = fills.get(status_value) or fills.get(row["ai_color"] or "red")
        for cell in sheet[sheet.max_row]:
            cell.fill = fill
            cell.alignment = Alignment(vertical="top", wrap_text=True)
        if before_link:
            sheet.cell(sheet.max_row, 26).hyperlink = before_link
            sheet.cell(sheet.max_row, 26).style = "Hyperlink"
        if after_link:
            sheet.cell(sheet.max_row, 27).hyperlink = after_link
            sheet.cell(sheet.max_row, 27).style = "Hyperlink"

    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    widths = [18, 28, 20, 24, 18, 18, 18, 14, 22, 16, 12, 20, 34, 22, 20, 20, 42, 20, 16, 16, 20, 22, 14, 16, 28, 28, 20, 22, 20, 20, 20, 42, 20, 18, 18, 18]
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width

    output = io.BytesIO()
    workbook.save(output)
    filename = f"ai_remediation_register_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.xlsx"
    return Response(
        content=output.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get(
    "/updates",
    response_model=list[RemediationUpdateItem],
    summary="Current user's remediation approval/rejection notifications",
)
async def remediation_updates(
    current_user: User = Depends(require_any),
    db: AsyncSession = Depends(get_db),
) -> list[RemediationUpdateItem]:
    rows = (
        await db.execute(
            select(Notification, PointVerification, Feature, Dataset, User.name)
            .outerjoin(PointVerification, PointVerification.id == Notification.source_id)
            .outerjoin(Feature, Feature.id == Notification.feature_id)
            .outerjoin(Dataset, Dataset.id == Feature.dataset_id)
            .outerjoin(User, User.id == Notification.actor_id)
            .where(
                Notification.user_id == current_user.id,
                Notification.source.in_(
                    [NotificationSource.REMEDIATION_APPROVED, NotificationSource.REMEDIATION_REJECTED]
                ),
            )
            .order_by(Notification.created_at.desc())
            .limit(50)
        )
    ).all()
    return [
        RemediationUpdateItem(
            notification_id=notification.id,
            verification_id=verification.id if verification else notification.source_id,
            feature_id=feature.id if feature else notification.feature_id,
            dataset_id=dataset.id if dataset else None,
            dataset_name=dataset.name if dataset else None,
            label=feature.label if feature else None,
            category=feature.category if feature else None,
            source=notification.source.value,
            message=notification.message,
            admin_name=admin_name,
            verified_condition=verification.verified_condition if verification else None,
            remarks=verification.remarks if verification else None,
            status=verification.status if verification else None,
            created_at=notification.created_at,
            read_at=notification.read_at,
        )
        for notification, verification, feature, dataset, admin_name in rows
    ]


@router.post(
    "/updates/{notification_id}/read",
    response_model=dict[str, bool],
    summary="Mark one remediation notification as read",
)
async def mark_remediation_update_read(
    notification_id: uuid.UUID,
    current_user: User = Depends(require_any),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    notification = (
        await db.execute(
            select(Notification).where(
                Notification.id == notification_id,
                Notification.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()
    if notification is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    notification.read_at = notification.read_at or datetime.now(timezone.utc)
    return {"ok": True}


@router.get(
    "/export-resolved-gdb",
    dependencies=[Depends(require_any)],
    summary="Generate a new GDB copy containing Admin-approved resolved conditions",
)
async def export_resolved_gdb(
    dataset_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    dataset = (await db.execute(select(Dataset).where(Dataset.id == dataset_id))).scalar_one_or_none()
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    rows = (
        await db.execute(
            text(
                """
                SELECT
                    pv.id::text AS verification_id,
                    pv.feature_id::text AS feature_id,
                    pv.anomaly_id::text AS anomaly_id,
                    COALESCE(NULLIF(f.attributes->>'gdb_layer', ''), NULLIF(f.attributes->>'LAYER', ''), f.category) AS source_layer,
                    COALESCE(f.attributes->>'FID', f.attributes->>'fid', f.attributes->>'OBJECTID', f.attributes->>'objectid') AS source_fid,
                    COALESCE(pv.original_condition, f.attributes->>'Condition', f.attributes->>'condition') AS original_condition,
                    pv.verified_condition,
                    architect.name AS architect_name,
                    pv.work_completed,
                    pv.work_completed_at,
                    admin.name AS admin_name,
                    pv.resolved_at,
                    pv.remarks,
                    pv.evidence_location_status
                FROM point_verifications pv
                JOIN features f ON f.id = pv.feature_id
                LEFT JOIN users architect ON architect.id = pv.architect_id
                LEFT JOIN users admin ON admin.id = pv.verified_by
                WHERE f.dataset_id = :dataset_id
                  AND pv.status = 'resolved'
                  AND pv.issue_fixed = TRUE
                  AND pv.verified_condition = 'good'
                ORDER BY pv.resolved_at DESC NULLS LAST
                """
            ),
            {"dataset_id": dataset_id},
        )
    ).mappings().all()

    records: list[ResolvedGdbRecord] = []
    for row in rows:
        if not row["source_layer"] or row["source_fid"] is None:
            continue
        records.append(
            ResolvedGdbRecord(
                verification_id=row["verification_id"],
                feature_id=row["feature_id"],
                source_layer=str(row["source_layer"]),
                source_fid=row["source_fid"],
                original_condition=row["original_condition"],
                verified_condition=str(row["verified_condition"]),
                architect_name=row["architect_name"],
                work_completed=row["work_completed"],
                work_completed_at=row["work_completed_at"],
                admin_name=row["admin_name"],
                resolved_at=row["resolved_at"],
                admin_remarks=row["remarks"],
                location_status=row["evidence_location_status"],
                anomaly_id=row["anomaly_id"],
            )
        )

    try:
        archive, temp_root, filename, updated = await generate_resolved_gdb(dataset, records)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    headers = {"X-Resolved-Feature-Count": str(updated)}
    return FileResponse(
        path=archive,
        media_type="application/zip",
        filename=filename,
        headers=headers,
        background=BackgroundTask(shutil.rmtree, temp_root, ignore_errors=True),
    )


@router.get(
    "/evidence/{verification_id}/{kind}",
    dependencies=[Depends(require_any)],
    summary="View Architect remediation evidence image",
)
async def remediation_evidence(
    verification_id: uuid.UUID,
    kind: str,
    db: AsyncSession = Depends(get_db),
) -> Response:
    row = (
        await db.execute(select(PointVerification).where(PointVerification.id == verification_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Remediation record not found")
    if kind == "before":
        key, content_type = row.before_photo_key, row.before_photo_content_type
    elif kind == "after":
        key, content_type = row.after_photo_key, row.after_photo_content_type
    else:
        raise HTTPException(status_code=404, detail="Evidence type not found")
    if not key:
        raise HTTPException(status_code=404, detail="Evidence image not found")
    try:
        payload = await get_object_bytes(key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Evidence image is unavailable") from exc
    return Response(content=payload, media_type=content_type or "application/octet-stream")


@router.post(
    "/{feature_id}/architect-submit",
    response_model=PointVerificationOut,
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
) -> PointVerificationOut:
    now = datetime.now(timezone.utc)
    if work_completed_at.tzinfo is None:
        work_completed_at = work_completed_at.replace(tzinfo=timezone.utc)
    if work_started_at and work_started_at.tzinfo is None:
        work_started_at = work_started_at.replace(tzinfo=timezone.utc)
    if work_started_at and work_completed_at < work_started_at:
        raise HTTPException(status_code=422, detail="Work completion time cannot be earlier than work start time")
    if work_completed_at > now.replace(microsecond=0):
        raise HTTPException(status_code=422, detail="Work completion time cannot be in the future")

    feature = await _load_feature(db, feature_id)
    anomaly = await _load_ai_anomaly(db, anomaly_id)
    _validate_ai_candidate(feature, anomaly, detection_mode)
    existing = await _load_verification(db, feature_id, anomaly.id)
    if existing and existing.anomaly_id == anomaly.id and existing.status == PointVerificationStatus.RESOLVED:
        raise HTTPException(status_code=409, detail="This AI finding is already Admin-approved")
    if existing and existing.anomaly_id == anomaly.id and existing.status == PointVerificationStatus.PENDING_ADMIN:
        raise HTTPException(status_code=409, detail="This remediation is already waiting for Admin verification")

    buffer_m = _BUFFER_BY_MODE[detection_mode]
    before = await _read_image(before_photo, "Before")
    after = await _read_image(after_photo, "After")

    # The after-work image is the final proof of the completed repair, so it
    # must contain real EXIF GPS. Manual latitude/longitude entry is not
    # accepted. The backend extracts and validates these coordinates itself.
    after_lat, after_lon = after[3], after[4]
    if after_lat is None or after_lon is None:
        raise HTTPException(
            status_code=422,
            detail="After-work photo has no GPS metadata. Upload the original geotagged image from the camera; screenshots, WhatsApp-compressed images, and edited copies may lose GPS data.",
        )
    if not (-90 <= after_lat <= 90) or not (-180 <= after_lon <= 180):
        raise HTTPException(status_code=422, detail="After-work photo contains invalid GPS coordinates")

    after_distance = await _distance_to_anomaly(db, anomaly.id, after_lat, after_lon)
    if after_distance > buffer_m:
        raise HTTPException(
            status_code=422,
            detail=f"After-work photo GPS is {after_distance:.1f} m from the AI point; allowed buffer is {buffer_m:.0f} m",
        )

    before_lat, before_lon = before[3], before[4]
    before_has_gps = before_lat is not None and before_lon is not None
    if before_has_gps:
        if not (-90 <= before_lat <= 90) or not (-180 <= before_lon <= 180):
            raise HTTPException(status_code=422, detail="Before-work photo contains invalid GPS coordinates")
        before_distance = await _distance_to_anomaly(db, anomaly.id, before_lat, before_lon)
        if before_distance > buffer_m:
            raise HTTPException(
                status_code=422,
                detail=f"Before-work photo GPS is {before_distance:.1f} m from the AI point; allowed buffer is {buffer_m:.0f} m",
            )

    evidence_latitude = after_lat
    evidence_longitude = after_lon
    evidence_distance = after_distance
    location_source = "before_and_after_photo_exif" if before_has_gps else "after_photo_exif"
    location_status = "photo_exif_verified"

    if existing is None:
        existing = PointVerification(id=uuid.uuid4(), feature_id=feature.id)
        db.add(existing)
    base_key = f"remediation/{feature.dataset_id}/{anomaly.id}/{existing.id}"
    before_key = f"{base_key}/before-{uuid.uuid4().hex[:10]}-{before[1]}"
    after_key = f"{base_key}/after-{uuid.uuid4().hex[:10]}-{after[1]}"
    uploaded_keys: list[str] = []
    try:
        await upload_stream(io.BytesIO(before[0]), key=before_key, content_type=before[2])
        uploaded_keys.append(before_key)
        await upload_stream(io.BytesIO(after[0]), key=after_key, content_type=after[2])
        uploaded_keys.append(after_key)

        existing.status = PointVerificationStatus.PENDING_ADMIN
        existing.issue_fixed = False
        if not existing.original_condition:
            existing.original_condition = _condition(feature.attributes or {})
        existing.verified_condition = None
        existing.architect_id = architect.id
        existing.issue_summary = issue_summary.strip()
        existing.work_completed = work_completed.strip()
        existing.work_started_at = work_started_at
        existing.work_completed_at = work_completed_at
        existing.architect_submitted_at = now
        existing.evidence_latitude = evidence_latitude
        existing.evidence_longitude = evidence_longitude
        existing.evidence_location_source = location_source
        existing.evidence_location_status = location_status
        existing.evidence_distance_m = evidence_distance
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
        attributes["_verification_status"] = PointVerificationStatus.PENDING_ADMIN.value
        attributes["_verification_issue_fixed"] = False
        attributes["_verification_anomaly_id"] = str(anomaly.id)
        attributes["_verification_detection_mode"] = detection_mode
        attributes["_verification_original_condition"] = existing.original_condition
        attributes["_verification_architect"] = architect.name
        attributes.pop("_verification_resolved_at", None)
        attributes.pop("_verification_verified_by", None)
        attributes.pop("_verification_verified_condition", None)
        attributes.pop("_verification_current_condition", None)
        attributes.pop("_verification_admin_assessed_condition", None)
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
                    "latitude": evidence_latitude,
                    "longitude": evidence_longitude,
                    "distance_m": round(evidence_distance, 3),
                    "buffer_m": buffer_m,
                    "location_status": location_status,
                },
            )
        )
        await _notify_admins(db, existing, architect, feature)
        await db.flush()
    except Exception:
        for key in uploaded_keys:
            try:
                await delete_object(key)
            except Exception:  # noqa: BLE001
                pass
        raise

    return await _to_out(db, feature, existing, anomaly, detection_mode)


@router.post(
    "/{feature_id}/admin-decision",
    response_model=PointVerificationOut,
    summary="Admin approves or rejects Architect remediation evidence",
)
async def admin_decision(
    feature_id: uuid.UUID,
    body: AdminDecisionIn,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PointVerificationOut:
    feature = await _load_feature(db, feature_id)
    anomaly = await _load_ai_anomaly(db, body.anomaly_id)
    _validate_ai_candidate(feature, anomaly, body.detection_mode)
    row = await _load_verification(db, feature_id, anomaly.id)
    if row is None or row.anomaly_id != anomaly.id:
        raise HTTPException(status_code=404, detail="Architect remediation submission was not found")
    if row.status == PointVerificationStatus.RESOLVED:
        raise HTTPException(status_code=409, detail="This AI finding is already Admin-approved")
    if row.status != PointVerificationStatus.PENDING_ADMIN:
        raise HTTPException(status_code=409, detail="This remediation is not waiting for Admin verification")
    if not row.before_photo_key or not row.after_photo_key or not row.architect_submitted_at:
        raise HTTPException(status_code=422, detail="Required Architect evidence is incomplete")

    now = datetime.now(timezone.utc)
    approved = body.decision == "approve"
    row.status = PointVerificationStatus.RESOLVED if approved else PointVerificationStatus.REJECTED
    row.issue_fixed = approved
    if not row.original_condition:
        row.original_condition = _condition(feature.attributes or {})
    row.verified_condition = body.verified_condition
    row.remarks = body.remarks.strip()
    row.inspected_at = now
    row.resolved_at = now if approved else None
    row.rejected_at = None if approved else now
    row.verified_by = admin.id
    anomaly.status = AnomalyStatus.RESOLVED if approved else AnomalyStatus.REVIEWING

    attributes = dict(feature.attributes or {})
    attributes["_verification_status"] = row.status.value
    attributes["_verification_issue_fixed"] = approved
    attributes["_verification_inspected_at"] = now.isoformat()
    attributes["_verification_remarks"] = row.remarks
    attributes["_verification_verified_by"] = admin.name
    attributes["_verification_anomaly_id"] = str(anomaly.id)
    attributes["_verification_detection_mode"] = body.detection_mode
    attributes["_verification_ai_type"] = anomaly.anomaly_type.value
    attributes["_verification_ai_color"] = anomaly.color.value
    attributes["_verification_ai_severity"] = anomaly.severity_score
    attributes["_verification_original_condition"] = row.original_condition
    attributes["_verification_admin_assessed_condition"] = body.verified_condition.value.title()
    if approved:
        attributes["_verification_resolved_at"] = now.isoformat()
        attributes["_verification_verified_condition"] = body.verified_condition.value.title()
        attributes["_verification_current_condition"] = body.verified_condition.value.title()
    else:
        attributes.pop("_verification_resolved_at", None)
        attributes.pop("_verification_verified_condition", None)
        attributes.pop("_verification_current_condition", None)
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
                "status": row.status.value,
                "remarks": row.remarks,
            },
        )
    )
    await _notify_architect(db, row, admin, approved)
    return await _to_out(db, feature, row, anomaly, body.detection_mode)


@router.get(
    "/{feature_id}",
    response_model=PointVerificationOut,
    dependencies=[Depends(require_any)],
    summary="View remediation state for an AI-detected red/yellow issue",
)
async def get_point_verification(
    feature_id: uuid.UUID,
    anomaly_id: uuid.UUID = Query(...),
    detection_mode: DetectionMode = Query(...),
    db: AsyncSession = Depends(get_db),
) -> PointVerificationOut:
    feature = await _load_feature(db, feature_id)
    anomaly = await _load_ai_anomaly(db, anomaly_id)
    _validate_ai_candidate(feature, anomaly, detection_mode)
    row = await _load_verification(db, feature_id, anomaly.id)
    return await _to_out(db, feature, row, anomaly, detection_mode)

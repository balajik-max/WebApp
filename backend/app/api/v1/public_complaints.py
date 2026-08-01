"""Public complaint submission, citizen status tracking, and officer review."""
from __future__ import annotations

import io
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.api.deps import require_operational
from app.api.public_deps import get_current_public_user
from app.core.config import get_settings
from app.core.net import client_ip, user_agent as request_user_agent
from app.db.session import get_db
from app.models import Notification, NotificationSource, User, UserRole
from app.models.public_portal import (
    PublicComplaint,
    PublicComplaintStatus,
    PublicNotification,
    PublicNotificationKind,
    PublicUser,
)
from app.schemas.public_portal import (
    OfficerPublicComplaintNotificationOut,
    OfficerPublicComplaintOut,
    PublicComplaintOut,
    PublicImageMetadataOut,
    PublicNotificationOut,
)
from app.services.storage import delete_object, get_object_bytes, upload_stream

router = APIRouter()
_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
_ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def safe_filename(filename: str | None) -> str:
    raw = Path(filename or "public-complaint.jpg").name
    cleaned = "".join(ch if ch.isalnum() or ch in {".", "-", "_"} else "_" for ch in raw)
    return cleaned[:180] or "public-complaint.jpg"


def rational_to_float(value: object) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        numerator = getattr(value, "numerator", 0)
        denominator = getattr(value, "denominator", 1) or 1
        return float(numerator) / float(denominator)


def gps_coordinate(values: object, ref: object) -> float | None:
    if not isinstance(values, (tuple, list)) or len(values) < 3:
        return None
    coordinate = rational_to_float(values[0]) + rational_to_float(values[1]) / 60 + rational_to_float(values[2]) / 3600
    if isinstance(ref, bytes):
        ref = ref.decode("ascii", errors="ignore")
    if str(ref).strip().upper() in {"S", "W"}:
        coordinate *= -1
    return coordinate


def extract_image_metadata(payload: bytes) -> tuple[float | None, float | None, datetime | None]:
    try:
        with Image.open(io.BytesIO(payload)) as image:
            image.verify()
        with Image.open(io.BytesIO(payload)) as image:
            exif = image.getexif()
            captured_at = None
            raw_date = exif.get(36867) or exif.get(306)
            if raw_date:
                try:
                    captured_at = datetime.strptime(str(raw_date), "%Y:%m:%d %H:%M:%S").replace(tzinfo=timezone.utc)
                except (TypeError, ValueError):
                    captured_at = None
            gps = exif.get_ifd(34853) if 34853 in exif else None
            if not gps:
                return None, None, captured_at
            return gps_coordinate(gps.get(2), gps.get(1)), gps_coordinate(gps.get(4), gps.get(3)), captured_at
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Uploaded complaint image is not valid") from exc


async def read_image(file: UploadFile) -> tuple[bytes, str, str, float | None, float | None, datetime | None]:
    settings = get_settings()
    max_bytes = settings.public_complaint_max_image_mb * 1024 * 1024
    filename = safe_filename(file.filename)
    suffix = Path(filename).suffix.lower()
    content_type = (file.content_type or "").lower()
    if suffix not in _ALLOWED_IMAGE_SUFFIXES or content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=422, detail="Complaint image must be JPG, JPEG, PNG, or WebP")
    payload = await file.read(max_bytes + 1)
    if not payload:
        raise HTTPException(status_code=422, detail="Complaint image is empty")
    if len(payload) > max_bytes:
        raise HTTPException(status_code=413, detail="Complaint image exceeds the configured size limit")
    lat, lon, captured_at = extract_image_metadata(payload)
    return payload, filename, content_type, lat, lon, captured_at


def resolve_complaint_location(
    *,
    location_source: str,
    exif_latitude: float | None,
    exif_longitude: float | None,
    browser_latitude: float | None,
    browser_longitude: float | None,
    browser_accuracy_m: float | None,
) -> tuple[float, float, float | None, str]:
    """Choose an authoritative complaint coordinate without trusting client EXIF claims."""
    has_image_geotag = (
        exif_latitude is not None
        and exif_longitude is not None
        and -90 <= exif_latitude <= 90
        and -180 <= exif_longitude <= 180
    )
    has_browser_location = (
        browser_latitude is not None
        and browser_longitude is not None
        and -90 <= browser_latitude <= 90
        and -180 <= browser_longitude <= 180
    )

    if location_source == "image_exif":
        if not has_image_geotag:
            raise HTTPException(
                status_code=422,
                detail="The selected image does not contain GPS coordinates. Use current device location instead.",
            )
        return exif_latitude, exif_longitude, None, "image_exif"

    if location_source == "browser_geolocation":
        if not has_browser_location:
            raise HTTPException(status_code=422, detail="Capture the current device location before submitting")
        return browser_latitude, browser_longitude, browser_accuracy_m, "browser_geolocation"

    if has_image_geotag:
        return exif_latitude, exif_longitude, None, "image_exif"
    if has_browser_location:
        return browser_latitude, browser_longitude, browser_accuracy_m, "browser_geolocation"
    raise HTTPException(
        status_code=422,
        detail="Upload a geo-tagged image or capture the current device location before submitting.",
    )


def public_complaint_out(row: PublicComplaint) -> PublicComplaintOut:
    return PublicComplaintOut(
        id=row.id,
        title=row.title,
        description=row.description,
        status=row.status,
        latitude=row.latitude,
        longitude=row.longitude,
        location_accuracy_m=row.location_accuracy_m,
        location_label=row.location_label,
        location_source=row.location_source,
        image_url=f"/api/public/complaints/{row.id}/image",
        commissioner_viewed_at=row.commissioner_viewed_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def officer_complaint_out(row: PublicComplaint) -> OfficerPublicComplaintOut:
    owner = row.public_user
    payload = public_complaint_out(row).model_dump()
    payload["image_url"] = f"/api/public/officer/complaints/{row.id}/image"
    return OfficerPublicComplaintOut(
        **payload,
        public_user_name=f"{owner.first_name} {owner.last_name}".strip(),
        public_username=owner.username,
        public_phone=owner.phone,
        image_exif_latitude=row.image_exif_latitude,
        image_exif_longitude=row.image_exif_longitude,
        submitted_ip=row.submitted_ip,
        submitted_user_agent=row.submitted_user_agent,
    )


async def load_owned_complaint(db: AsyncSession, complaint_id: uuid.UUID, public_user_id: uuid.UUID) -> PublicComplaint:
    row = (
        await db.execute(
            select(PublicComplaint).where(
                PublicComplaint.id == complaint_id,
                PublicComplaint.public_user_id == public_user_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Public complaint not found")
    return row


@router.post("/complaints/image-metadata", response_model=PublicImageMetadataOut)
async def inspect_complaint_image(
    image: UploadFile = File(...),
    _public_user: PublicUser = Depends(get_current_public_user),
) -> PublicImageMetadataOut:
    """Validate an image and read embedded GPS without storing the file."""
    payload, filename, content_type, exif_lat, exif_lon, captured_at = await read_image(image)
    has_geotag = (
        exif_lat is not None
        and exif_lon is not None
        and -90 <= exif_lat <= 90
        and -180 <= exif_lon <= 180
    )
    return PublicImageMetadataOut(
        filename=filename,
        size_bytes=len(payload),
        content_type=content_type,
        has_geotag=has_geotag,
        latitude=exif_lat if has_geotag else None,
        longitude=exif_lon if has_geotag else None,
        captured_at=captured_at,
    )


@router.post("/complaints", response_model=PublicComplaintOut)
async def submit_complaint(
    request: Request,
    title: str = Form(..., min_length=3, max_length=200),
    description: str = Form(..., min_length=10, max_length=5000),
    latitude: float | None = Form(default=None, ge=-90, le=90),
    longitude: float | None = Form(default=None, ge=-180, le=180),
    location_accuracy_m: float | None = Form(default=None, ge=0, le=100000),
    location_label: str | None = Form(default=None, max_length=500),
    location_source: str = Form(default="auto", pattern=r"^(auto|image_exif|browser_geolocation)$"),
    image: UploadFile = File(...),
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> PublicComplaintOut:
    payload, filename, content_type, exif_lat, exif_lon, captured_at = await read_image(image)
    effective_latitude, effective_longitude, effective_accuracy, effective_source = resolve_complaint_location(
        location_source=location_source,
        exif_latitude=exif_lat,
        exif_longitude=exif_lon,
        browser_latitude=latitude,
        browser_longitude=longitude,
        browser_accuracy_m=location_accuracy_m,
    )

    row = PublicComplaint(
        public_user_id=public_user.id,
        title=" ".join(title.split()),
        description=description.strip(),
        status=PublicComplaintStatus.SUBMITTED,
        image_key="pending",
        image_filename=filename,
        image_content_type=content_type,
        image_exif_latitude=exif_lat,
        image_exif_longitude=exif_lon,
        image_captured_at=captured_at,
        latitude=effective_latitude,
        longitude=effective_longitude,
        location_accuracy_m=effective_accuracy,
        location_label=location_label,
        location_source=effective_source,
        submitted_ip=client_ip(request),
        submitted_user_agent=request_user_agent(request),
    )
    db.add(row)
    await db.flush()
    key = f"public-complaints/{public_user.id}/{row.id}/{filename}"
    try:
        await upload_stream(io.BytesIO(payload), key=key, content_type=content_type)
        row.image_key = key

        officers = (
            await db.execute(
                select(User).where(
                    User.is_active.is_(True),
                    User.role.in_([UserRole.AE, UserRole.AEE, UserRole.COMMISSIONER]),
                )
            )
        ).scalars().all()
        for officer in officers:
            db.add(
                Notification(
                    user_id=officer.id,
                    actor_id=None,
                    source=NotificationSource.PUBLIC_COMPLAINT_SUBMITTED,
                    source_id=row.id,
                    feature_id=None,
                    message=(
                        f"New public complaint from {public_user.first_name} {public_user.last_name}: "
                        f"{row.title}"
                    ),
                )
            )
        db.add(
            PublicNotification(
                public_user_id=public_user.id,
                complaint_id=row.id,
                kind=PublicNotificationKind.COMPLAINT_SUBMITTED,
                message="Complaint submitted successfully.",
            )
        )
        await db.flush()
    except Exception:
        if row.image_key != "pending":
            await delete_object(row.image_key)
        raise
    return public_complaint_out(row)


@router.get("/complaints", response_model=list[PublicComplaintOut])
async def list_my_complaints(
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> list[PublicComplaintOut]:
    rows = (
        await db.execute(
            select(PublicComplaint)
            .where(PublicComplaint.public_user_id == public_user.id)
            .order_by(PublicComplaint.created_at.desc())
        )
    ).scalars().all()
    return [public_complaint_out(row) for row in rows]


@router.get("/complaints/{complaint_id}", response_model=PublicComplaintOut)
async def get_my_complaint(
    complaint_id: uuid.UUID,
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> PublicComplaintOut:
    return public_complaint_out(await load_owned_complaint(db, complaint_id, public_user.id))


@router.get("/complaints/{complaint_id}/image")
async def get_my_complaint_image(
    complaint_id: uuid.UUID,
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    row = await load_owned_complaint(db, complaint_id, public_user.id)
    return Response(content=await get_object_bytes(row.image_key), media_type=row.image_content_type)


@router.get("/notifications", response_model=list[PublicNotificationOut])
async def list_public_notifications(
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> list[PublicNotificationOut]:
    rows = (
        await db.execute(
            select(PublicNotification)
            .where(PublicNotification.public_user_id == public_user.id)
            .order_by(PublicNotification.created_at.desc())
            .limit(100)
        )
    ).scalars().all()
    return [PublicNotificationOut.model_validate(row) for row in rows]


@router.post("/notifications/{notification_id}/read")
async def mark_public_notification_read(
    notification_id: uuid.UUID,
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    row = (
        await db.execute(
            select(PublicNotification).where(
                PublicNotification.id == notification_id,
                PublicNotification.public_user_id == public_user.id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Public notification not found")
    row.read_at = row.read_at or datetime.now(timezone.utc)
    return {"ok": True}


# -------------------------------------------------------------------------
# Officer-facing endpoints. These use the existing officer auth and roles.
# -------------------------------------------------------------------------
@router.get("/officer/notifications", response_model=list[OfficerPublicComplaintNotificationOut])
async def officer_notifications(
    current_user: User = Depends(require_operational),
    db: AsyncSession = Depends(get_db),
) -> list[OfficerPublicComplaintNotificationOut]:
    rows = (
        await db.execute(
            select(Notification, PublicComplaint)
            .join(PublicComplaint, PublicComplaint.id == Notification.source_id)
            .where(
                Notification.user_id == current_user.id,
                Notification.source == NotificationSource.PUBLIC_COMPLAINT_SUBMITTED,
            )
            .order_by(Notification.created_at.desc())
            .limit(100)
        )
    ).all()
    return [
        OfficerPublicComplaintNotificationOut(
            notification_id=notification.id,
            complaint_id=complaint.id,
            title="New public complaint",
            message=notification.message,
            created_at=notification.created_at,
            read_at=notification.read_at,
        )
        for notification, complaint in rows
    ]


@router.post("/officer/notifications/{notification_id}/read")
async def mark_officer_notification_read(
    notification_id: uuid.UUID,
    current_user: User = Depends(require_operational),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    row = (
        await db.execute(
            select(Notification).where(
                Notification.id == notification_id,
                Notification.user_id == current_user.id,
                Notification.source == NotificationSource.PUBLIC_COMPLAINT_SUBMITTED,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Officer notification not found")
    row.read_at = row.read_at or datetime.now(timezone.utc)
    return {"ok": True}


@router.get("/officer/complaints/{complaint_id}", response_model=OfficerPublicComplaintOut)
async def officer_complaint_detail(
    complaint_id: uuid.UUID,
    current_user: User = Depends(require_operational),
    db: AsyncSession = Depends(get_db),
) -> OfficerPublicComplaintOut:
    stmt = (
        select(PublicComplaint)
        .options(joinedload(PublicComplaint.public_user))
        .where(PublicComplaint.id == complaint_id)
    )
    stmt = stmt.with_for_update(of=PublicComplaint)
    row = (await db.execute(stmt)).unique().scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Public complaint not found")

    if current_user.role == UserRole.COMMISSIONER and row.commissioner_viewed_at is None:
        now = datetime.now(timezone.utc)
        row.commissioner_viewed_at = now
        row.commissioner_viewed_by = current_user.id
        row.status = PublicComplaintStatus.VIEWED_BY_COMMISSIONER
        db.add(
            PublicNotification(
                public_user_id=row.public_user_id,
                complaint_id=row.id,
                kind=PublicNotificationKind.COMMISSIONER_VIEWED,
                message="Authority viewed your problem.",
            )
        )
        await db.flush()
    elif row.status == PublicComplaintStatus.SUBMITTED:
        # First AE/AEE view records that the complaint has reached the officer
        # side without altering any existing remediation workflow.
        row.status = PublicComplaintStatus.RECEIVED
        await db.flush()

    return officer_complaint_out(row)


@router.get("/officer/complaints/{complaint_id}/image")
async def officer_complaint_image(
    complaint_id: uuid.UUID,
    current_user: User = Depends(require_operational),
    db: AsyncSession = Depends(get_db),
) -> Response:
    del current_user
    row = await db.scalar(select(PublicComplaint).where(PublicComplaint.id == complaint_id))
    if row is None:
        raise HTTPException(status_code=404, detail="Public complaint not found")
    return Response(content=await get_object_bytes(row.image_key), media_type=row.image_content_type)

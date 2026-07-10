"""
ImageReader — geo-tagged site photographs (.jpg/.jpeg/.png/.gif/.bmp/.webp),
either a single photo or a zip bundle of many (a zipped folder, or several
individually selected/dropped photos zipped client-side).

Each photo becomes ONE Feature — a Point at its real EXIF GPS location —
plus the original image bytes stored in object storage, so the map can
show the actual photo when its pin is clicked. This mirrors how real
field-survey photo apps (e.g. NoteCam-style tools) work: they burn a
human-readable overlay onto the image AND write real GPS coordinates into
the file's EXIF metadata, specifically so downstream GIS tools can read
the location programmatically instead of guessing from the visible text.

Photos with no EXIF GPS tag are skipped (not guessed at, not placed at a
synthetic location) — the same "skip and report, never fabricate a
location" rule every other reader in this pipeline follows.
"""
from __future__ import annotations

import asyncio
import io
import logging
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from geoalchemy2.shape import from_shape
from PIL import Image
from shapely.geometry import Point

from app.db.session import SessionLocal
from app.models import Feature
from app.services.readers.base import ReaderResult
from app.services.storage import upload_stream

log = logging.getLogger("davangere.readers.image")

_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}
_BATCH_SIZE = 200
_MAX_PHOTOS = 500  # sanity cap per upload

_GPS_IFD_TAG = 0x8825  # 34853 — GPSInfo pointer in IFD0
_EXIF_IFD_TAG = 0x8769  # 34665 — Exif SubIFD pointer in IFD0
_DATETIME_ORIGINAL_TAG = 0x9003  # 36867 — lives inside the Exif SubIFD
_GPS_H_POSITIONING_ERROR_TAG = 0x1F  # 31 — the phone/GPS chip's own reported accuracy, in metres

_CONTENT_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp",
}


@dataclass(slots=True)
class _ParsedPhoto:
    filename: str
    image_bytes: bytes
    content_type: str
    lat: float
    lon: float
    altitude: float | None
    taken_at: str | None
    gps_accuracy_m: float | None
    is_360: bool


@dataclass(slots=True)
class _ParsedBatch:
    photos: list[_ParsedPhoto]
    skipped: int = 0
    skip_reasons: list[str] = field(default_factory=list)


def _to_degrees(dms) -> float:
    """Converts an EXIF GPS (degrees, minutes, seconds) triple to decimal degrees."""
    d, m, s = dms
    return float(d) + float(m) / 60.0 + float(s) / 3600.0


def _extract_taken_at(exif) -> str | None:
    try:
        exif_ifd = exif.get_ifd(_EXIF_IFD_TAG)
        dt = exif_ifd.get(_DATETIME_ORIGINAL_TAG)
        return str(dt) if dt else None
    except Exception:  # noqa: BLE001
        return None


def _extract_gps(img: Image.Image) -> tuple[float, float, float | None, str | None, float | None] | None:
    exif = img.getexif()
    if not exif:
        return None
    try:
        gps_ifd = exif.get_ifd(_GPS_IFD_TAG)
    except Exception:  # noqa: BLE001
        return None
    if not gps_ifd:
        return None

    lat_dms, lat_ref = gps_ifd.get(2), gps_ifd.get(1)
    lon_dms, lon_ref = gps_ifd.get(4), gps_ifd.get(3)
    if not (lat_dms and lon_dms and lat_ref and lon_ref):
        return None

    try:
        lat = _to_degrees(lat_dms)
        if str(lat_ref).upper().startswith("S"):
            lat = -lat
        lon = _to_degrees(lon_dms)
        if str(lon_ref).upper().startswith("W"):
            lon = -lon
    except (TypeError, ValueError, ZeroDivisionError):
        return None

    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None

    altitude = None
    alt_val = gps_ifd.get(6)
    if alt_val is not None:
        try:
            altitude = float(alt_val)
            # GPSAltitudeRef is a single-byte EXIF value (0=above sea
            # level, 1=below) but Pillow can hand it back as either an
            # int or raw bytes depending on the read path — normalize
            # before comparing so "below sea level" is never missed.
            alt_ref = gps_ifd.get(5)
            alt_ref_int = alt_ref[0] if isinstance(alt_ref, (bytes, bytearray)) else alt_ref
            if alt_ref_int == 1:
                altitude = -altitude
        except (TypeError, ValueError, IndexError):
            altitude = None

    gps_accuracy_m = None
    accuracy_val = gps_ifd.get(_GPS_H_POSITIONING_ERROR_TAG)
    if accuracy_val is not None:
        try:
            gps_accuracy_m = float(accuracy_val)
        except (TypeError, ValueError):
            gps_accuracy_m = None

    return lat, lon, altitude, _extract_taken_at(exif), gps_accuracy_m


def _is_panorama(img: Image.Image) -> bool:
    """Detects a real 360° equirectangular panorama (not just any wide
    photo) so the map can offer an immersive sphere viewer instead of a
    flat lightbox for it.

    Primary signal: Google's `GPano` XMP schema — the same metadata
    Street View / photo-sphere apps (and most 360 cameras) write into the
    file specifically so software can detect this programmatically,
    without needing to guess. We check the raw XMP bytes directly with a
    substring search rather than full XML parsing (which would need the
    optional `defusedxml` dependency Pillow's `getxmp()` requires) —
    robust enough for a single well-known tag/value pair.

    Fallback: a real equirectangular image is always exactly 2:1
    (width:height), because that ratio is what lets 360° horizontal and
    180° vertical field of view map onto the rectangle without
    distortion in the projection itself. A photo that merely happens to
    be wide (e.g. 3:2, 16:9) is not a panorama and must not be forced
    into a sphere, where it would wrap incorrectly.
    """
    raw_xmp = img.info.get("xmp")
    if raw_xmp:
        text = raw_xmp.decode("utf-8", errors="ignore") if isinstance(raw_xmp, bytes) else str(raw_xmp)
        if "GPano" in text and "equirectangular" in text.lower():
            return True

    width, height = img.size
    if height == 0:
        return False
    ratio = width / height
    return 1.95 <= ratio <= 2.05


class ImageReader:
    """Handles geo-tagged site photographs — a single image file, or a
    zip bundle of many (zipped folder, or several photos zipped
    client-side after a multi-select/drag-drop)."""

    def can_handle(self, filename: str) -> bool:
        return Path(filename).suffix.lower() in _IMAGE_SUFFIXES

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:
        parsed = await asyncio.to_thread(self._parse_sync, file_path)
        if not parsed.photos:
            notes = "; ".join(parsed.skip_reasons[:5]) or "No geo-tagged photos found"
            return ReaderResult(inserted=0, skipped=parsed.skipped, source_crs=None, notes=notes)
        return await self._persist(parsed, dataset_id=dataset_id)

    def _parse_sync(self, file_path: Path) -> _ParsedBatch:
        photos: list[_ParsedPhoto] = []
        skipped = 0
        skip_reasons: list[str] = []

        def _handle_one(name: str, data: bytes) -> None:
            nonlocal skipped
            if len(photos) >= _MAX_PHOTOS:
                skipped += 1
                return
            ext = Path(name).suffix.lower()
            try:
                with Image.open(io.BytesIO(data)) as img:
                    gps = _extract_gps(img)
                    is_360 = _is_panorama(img)
            except Exception as exc:  # noqa: BLE001
                skipped += 1
                skip_reasons.append(f"{name}: unreadable image ({exc})")
                return
            if gps is None:
                skipped += 1
                skip_reasons.append(f"{name}: no GPS EXIF data")
                return
            lat, lon, altitude, taken_at, gps_accuracy_m = gps
            photos.append(
                _ParsedPhoto(
                    filename=Path(name).name,
                    image_bytes=data,
                    content_type=_CONTENT_TYPES.get(ext, "application/octet-stream"),
                    lat=lat,
                    lon=lon,
                    altitude=altitude,
                    taken_at=taken_at,
                    is_360=is_360,
                    gps_accuracy_m=gps_accuracy_m,
                )
            )

        if file_path.suffix.lower() == ".zip":
            with zipfile.ZipFile(file_path) as zf:
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    if Path(info.filename).suffix.lower() not in _IMAGE_SUFFIXES:
                        continue
                    with zf.open(info) as fh:
                        _handle_one(info.filename, fh.read())
        else:
            _handle_one(file_path.name, file_path.read_bytes())

        return _ParsedBatch(photos=photos, skipped=skipped, skip_reasons=skip_reasons)

    async def _persist(self, parsed: _ParsedBatch, *, dataset_id: str) -> ReaderResult:
        dataset_uuid = uuid.UUID(dataset_id)
        inserted = 0
        skipped = parsed.skipped
        batch: list[Feature] = []

        async with SessionLocal() as session:
            for photo in parsed.photos:
                photo_key = f"datasets/{dataset_id}/photos/{uuid.uuid4()}{Path(photo.filename).suffix.lower()}"
                try:
                    await upload_stream(
                        io.BytesIO(photo.image_bytes), key=photo_key, content_type=photo.content_type
                    )
                except Exception:  # noqa: BLE001
                    log.exception("Failed to upload photo %s for dataset %s", photo.filename, dataset_id)
                    skipped += 1
                    continue

                attrs = {
                    "filename": photo.filename,
                    "photo_key": photo_key,
                    "content_type": photo.content_type,
                    "latitude": photo.lat,
                    "longitude": photo.lon,
                    "altitude_m": photo.altitude,
                    "taken_at": photo.taken_at,
                    # The phone/GPS chip's own reported horizontal accuracy
                    # (GPSHPositioningError), in metres — surfaced so a pin
                    # that lands near-but-not-exactly-on a building reads as
                    # "real GPS margin of error", not a placement bug.
                    "gps_accuracy_m": photo.gps_accuracy_m,
                    # Real 360° equirectangular panorama, detected from
                    # GPano XMP metadata or a 2:1 aspect ratio — tells the
                    # map to open an immersive sphere viewer instead of a
                    # flat lightbox for this photo.
                    "is_360": photo.is_360,
                }

                batch.append(
                    Feature(
                        dataset_id=dataset_uuid,
                        label=photo.filename,
                        category="site_photo",
                        severity=0.0,
                        attributes=attrs,
                        geom=from_shape(Point(photo.lon, photo.lat), srid=4326),
                    )
                )
                inserted += 1

                if len(batch) >= _BATCH_SIZE:
                    session.add_all(batch)
                    await session.flush()
                    batch.clear()

            if batch:
                session.add_all(batch)
                await session.flush()

            await session.commit()

        log.info(
            "ImageReader ingested dataset_id=%s inserted=%d skipped=%d",
            dataset_id,
            inserted,
            skipped,
        )
        return ReaderResult(
            inserted=inserted,
            skipped=skipped,
            source_crs="EPSG:4326",
            notes=f"geo-tagged photos={inserted}, skipped={skipped}",
        )

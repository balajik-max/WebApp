"""Regression tests for already geo-tagged complaint images."""
from __future__ import annotations

import io

from fastapi import HTTPException
from PIL import Image

from app.api.v1.public_complaints import extract_image_metadata, resolve_complaint_location


def test_valid_image_without_gps_returns_no_geotag() -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), "white").save(buffer, format="JPEG")
    latitude, longitude, _captured_at = extract_image_metadata(buffer.getvalue())
    assert latitude is None
    assert longitude is None


def test_embedded_image_gps_can_be_authoritative() -> None:
    latitude, longitude, accuracy, source = resolve_complaint_location(
        location_source="image_exif",
        exif_latitude=14.4644,
        exif_longitude=75.9218,
        browser_latitude=None,
        browser_longitude=None,
        browser_accuracy_m=None,
    )
    assert (latitude, longitude) == (14.4644, 75.9218)
    assert accuracy is None
    assert source == "image_exif"


def test_image_without_gps_requires_browser_location() -> None:
    try:
        resolve_complaint_location(
            location_source="image_exif",
            exif_latitude=None,
            exif_longitude=None,
            browser_latitude=None,
            browser_longitude=None,
            browser_accuracy_m=None,
        )
    except HTTPException as exc:
        assert exc.status_code == 422
    else:
        raise AssertionError("Missing image GPS must be rejected")

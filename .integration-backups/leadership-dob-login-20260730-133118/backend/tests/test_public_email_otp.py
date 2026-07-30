"""Focused regression tests for staged email OTP registration contracts."""
from __future__ import annotations

from datetime import date

from app.schemas.public_portal import (
    PublicOtpRequest,
    PublicOtpVerifyRequest,
    PublicRegisterRequest,
)
from app.services.public_otp import mask_email


def test_email_otp_request_keeps_phone_as_contact() -> None:
    payload = PublicOtpRequest(phone="9876543210", email="Citizen.User@Example.com")
    assert payload.phone == "9876543210"
    assert str(payload.email) == "Citizen.User@example.com"


def test_otp_verification_is_a_separate_contract() -> None:
    payload = PublicOtpVerifyRequest(
        challenge_id="00000000-0000-0000-0000-000000000001",
        otp="123456",
    )
    assert payload.otp == "123456"
    assert not hasattr(payload, "password")


def test_registration_requires_verified_token_and_not_raw_otp_or_gps() -> None:
    payload = PublicRegisterRequest(
        challenge_id="00000000-0000-0000-0000-000000000001",
        registration_token="x" * 64,
        first_name="Citizen",
        last_name="User",
        date_of_birth=date(1990, 1, 1),
        username="citizen.user",
        password="Strong@123",
        confirm_password="Strong@123",
    )
    assert not hasattr(payload, "otp")
    assert not hasattr(payload, "latitude")
    assert not hasattr(payload, "longitude")


def test_mask_email_does_not_reveal_full_mailbox() -> None:
    masked = mask_email("citizen.user@example.com")
    assert masked.endswith("@example.com")
    assert "citizen.user" not in masked

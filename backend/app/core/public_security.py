"""Security helpers for the separate public/citizen authentication boundary."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt

from app.core.config import get_settings

PUBLIC_TOKEN_TYPE_ACCESS = "public_access"
PUBLIC_TOKEN_TYPE_REFRESH = "public_refresh"


def _encode(payload: dict[str, Any]) -> str:
    settings = get_settings()
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_public_access_token(*, user_id: uuid.UUID, username: str) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    return _encode(
        {
            "sub": str(user_id),
            "username": username,
            "role": "public",
            "type": PUBLIC_TOKEN_TYPE_ACCESS,
            "iat": now,
            "exp": now + timedelta(minutes=settings.jwt_access_ttl_min),
        }
    )


def create_public_refresh_token(*, user_id: uuid.UUID) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    return _encode(
        {
            "sub": str(user_id),
            "role": "public",
            "type": PUBLIC_TOKEN_TYPE_REFRESH,
            "iat": now,
            "exp": now + timedelta(days=settings.jwt_refresh_ttl_days),
        }
    )


def decode_public_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])


def generate_otp() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def otp_digest(challenge_id: uuid.UUID, code: str) -> str:
    settings = get_settings()
    payload = f"{challenge_id}:{code}".encode("utf-8")
    return hmac.new(settings.jwt_secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def verify_otp_digest(challenge_id: uuid.UUID, code: str, expected: str) -> bool:
    return hmac.compare_digest(otp_digest(challenge_id, code), expected)

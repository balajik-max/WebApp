"""
Password hashing (bcrypt) + JWT access/refresh token helpers.
Nothing here reads from the environment directly — all secrets flow through
`app.core.config.get_settings()` so the process fails fast on misconfiguration.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt

from app.core.config import get_settings

TOKEN_TYPE_ACCESS = "access"
TOKEN_TYPE_REFRESH = "refresh"


# --------------------------------------------------------------------- bcrypt
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


# ----------------------------------------------------------------------- jwt
def _encode(payload: dict[str, Any]) -> str:
    settings = get_settings()
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_access_token(*, user_id: uuid.UUID, email: str, role: str) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    return _encode(
        {
            "sub": str(user_id),
            "email": email,
            "role": role,
            "type": TOKEN_TYPE_ACCESS,
            "iat": now,
            "exp": now + timedelta(minutes=settings.jwt_access_ttl_min),
        }
    )


def create_refresh_token(*, user_id: uuid.UUID) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    return _encode(
        {
            "sub": str(user_id),
            "type": TOKEN_TYPE_REFRESH,
            "iat": now,
            "exp": now + timedelta(days=settings.jwt_refresh_ttl_days),
        }
    )


def decode_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])

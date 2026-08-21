"""Shared FastAPI dependencies (auth, role guards, DB session)."""
from __future__ import annotations

import uuid
from typing import AsyncGenerator

import jwt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import TOKEN_TYPE_ACCESS, decode_token
from app.db.session import get_db, get_auth_db, get_db_by_role
from app.models import User, UserRole


def _extract_token(request: Request) -> str:
    token = request.cookies.get("access_token")
    if token:
        return token

    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
    )


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_auth_db),
) -> User:
    """Get the current user from the auth database."""
    token = _extract_token(request)

    try:
        payload = decode_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    if payload.get("type") != TOKEN_TYPE_ACCESS:
        raise HTTPException(status_code=401, detail="Invalid token type")

    try:
        user_id = uuid.UUID(str(payload["sub"]))
    except (KeyError, ValueError):
        raise HTTPException(
            status_code=401,
            detail="Malformed token subject",
        )

    result = await db.execute(
        select(User).where(User.id == user_id)
    )
    user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(status_code=401, detail="User not found")

    if not user.is_active:
        raise HTTPException(
            status_code=403,
            detail="Account is inactive",
        )

    # MLA can inspect all map, layer, analytics, and workflow data but cannot
    # mutate application state. This global guard prevents accidental writes
    # even if a future endpoint forgets a role-specific dependency.
    # Exempted as non-destructive, MLA-appropriate oversight: its own auth
    # session (logout/heartbeat/change-password), running the spatial audit
    # engine (recomputes findings from already-surveyed data, doesn't let
    # MLA edit anything), the activity log endpoint, and loading (uploading)
    # geospatial datasets into the system for review.
    _mla_write_allowed = {
        "/api/auth/logout",
        "/api/auth/heartbeat",
        "/api/auth/change-password",
        "/api/v1/activity/log",
        "/api/v1/datasets/upload",
    }
    # Normalize path (strip trailing slash) for reliable matching across
    # reverse-proxy and ASGI URL normalization variants.
    _req_path = request.url.path.rstrip("/")
    if (
        user.role == UserRole.MLA
        and request.method not in {"GET", "HEAD", "OPTIONS"}
        and _req_path not in _mla_write_allowed
    ):
        raise HTTPException(
            status_code=403,
            detail="MLA access is strictly read-only",
        )

    return user


async def get_role_db_session(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[AsyncSession, None]:
    """Get a database session for the current user's role-specific database.

    This provides data isolation between roles - each role has its own database.
    """
    async for session in get_db_by_role(user.role.value):
        yield session


def require_roles(*allowed: UserRole):
    """Factory returning a dependency that only permits given roles."""

    async def _guard(
        user: User = Depends(get_current_user),
    ) -> User:
        if user.role not in allowed:
            raise HTTPException(
                status_code=403,
                detail="Forbidden",
            )
        return user

    return _guard


# Existing colleague guards are intentionally preserved.
require_admin = require_roles(UserRole.ADMIN)
require_architect = require_roles(UserRole.ARCHITECT)

# Operational remediation guards.
require_commissioner = require_roles(UserRole.COMMISSIONER)
require_ae = require_roles(UserRole.AE)
require_aee = require_roles(UserRole.AEE)
require_operational = require_roles(
    UserRole.COMMISSIONER,
    UserRole.AEE,
    UserRole.AE,
    UserRole.MLA,
)

# All authenticated roles remain able to use existing read endpoints.
require_any = require_roles(
    UserRole.COMMISSIONER,
    UserRole.AEE,
    UserRole.AE,
    UserRole.MLA,
    UserRole.ADMIN,
    UserRole.ARCHITECT,
)

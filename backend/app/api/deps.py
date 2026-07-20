"""Shared FastAPI dependencies (auth, role guards, DB session)."""
from __future__ import annotations

import uuid

import jwt
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import TOKEN_TYPE_ACCESS, decode_token
from app.db.session import get_db
from app.models import User, UserRole


def _extract_token(request: Request) -> str:
    token = request.cookies.get("access_token")
    if token:
        return token
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
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
        raise HTTPException(status_code=401, detail="Malformed token subject")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is inactive")
    if (
        user.role == UserRole.MLA
        and request.method not in {"GET", "HEAD", "OPTIONS"}
        and request.url.path != "/api/auth/logout"
    ):
        raise HTTPException(status_code=403, detail="MLA access is strictly read-only")
    return user


def require_roles(*allowed: UserRole):
    """Factory returning a dependency that only permits given roles."""

    async def _guard(user: User = Depends(get_current_user)) -> User:
        if user.role not in allowed:
            raise HTTPException(status_code=403, detail="Forbidden")
        return user

    return _guard


require_commissioner = require_roles(UserRole.COMMISSIONER)
require_field_officer = require_roles(UserRole.AE, UserRole.AEE)
require_operational = require_roles(UserRole.COMMISSIONER, UserRole.AEE, UserRole.AE)
require_any = require_roles(
    UserRole.COMMISSIONER, UserRole.AEE, UserRole.AE, UserRole.MLA
)

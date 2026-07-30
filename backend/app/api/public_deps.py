"""Authentication dependency for the isolated public/citizen portal."""
from __future__ import annotations

import uuid

import jwt
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.public_security import PUBLIC_TOKEN_TYPE_ACCESS, decode_public_token
from app.db.session import get_db
from app.models.public_portal import PublicUser


def extract_public_token(request: Request) -> str:
    token = request.cookies.get("public_access_token")
    if token:
        return token
    auth = request.headers.get("Authorization", "")
    if auth.startswith("PublicBearer "):
        return auth[len("PublicBearer "):]
    raise HTTPException(status_code=401, detail="Public user is not authenticated")


async def get_current_public_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> PublicUser:
    token = extract_public_token(request)
    try:
        payload = decode_public_token(token)
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Public session expired") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid public session") from exc

    if payload.get("type") != PUBLIC_TOKEN_TYPE_ACCESS or payload.get("role") != "public":
        raise HTTPException(status_code=401, detail="Invalid public token type")

    try:
        user_id = uuid.UUID(str(payload["sub"]))
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="Malformed public token subject") from exc

    user = (
        await db.execute(select(PublicUser).where(PublicUser.id == user_id))
    ).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Public account is unavailable")
    return user

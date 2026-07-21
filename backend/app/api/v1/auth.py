"""
Authentication endpoints.

Endpoints:
  POST /api/auth/login    – email + password → access/refresh tokens (cookies + JSON)
  POST /api/auth/logout   – clears auth cookies
  GET  /api/auth/me       – returns current user (requires access token)
  POST /api/auth/refresh  – rotates access token using refresh cookie
"""
from __future__ import annotations

import logging
import uuid

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.core.security import (
    TOKEN_TYPE_REFRESH,
    create_access_token,
    create_refresh_token,
    decode_token,
    verify_password,
)
from app.db.session import get_db
from app.models import ActivityAction, ActivityLog, User
from app.schemas.auth import LoginRequest, TokenResponse
from app.schemas.user import UserPublic

log = logging.getLogger("davangere.auth")
router = APIRouter()


def _set_auth_cookies(response: Response, access: str, refresh: str) -> None:
    settings = get_settings()
    is_prod = settings.app_env == "production"
    response.set_cookie(
        "access_token",
        access,
        httponly=True,
        secure=is_prod,
        samesite="lax",
        max_age=settings.jwt_access_ttl_min * 60,
        path="/",
    )
    response.set_cookie(
        "refresh_token",
        refresh,
        httponly=True,
        secure=is_prod,
        samesite="lax",
        max_age=settings.jwt_refresh_ttl_days * 86400,
        path="/",
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    email = payload.email.strip().lower()

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()

    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    access = create_access_token(user_id=user.id, email=user.email, role=user.role.value)
    refresh = create_refresh_token(user_id=user.id)
    _set_auth_cookies(response, access, refresh)

    db.add(
        ActivityLog(
            actor_id=user.id,
            action=ActivityAction.LOGIN,
            entity_type="user",
            entity_id=user.id,
            payload={"ip": request.client.host if request.client else None},
        )
    )
    await db.commit()

    return TokenResponse(
        access_token=access,
        refresh_token=refresh,
        token_type="bearer",
        user=UserPublic.model_validate(user),
    )


@router.post("/logout")
async def logout(response: Response, user: User = Depends(get_current_user)) -> dict:
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    return {"ok": True, "user_id": str(user.id)}


@router.get("/me", response_model=UserPublic)
async def me(user: User = Depends(get_current_user)) -> UserPublic:
    return UserPublic.model_validate(user)


@router.post("/refresh")
async def refresh_token(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict:
    token = request.cookies.get("refresh_token")
    if not token:
        raise HTTPException(status_code=401, detail="Missing refresh token")
    try:
        payload = decode_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Refresh token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    if payload.get("type") != TOKEN_TYPE_REFRESH:
        raise HTTPException(status_code=401, detail="Invalid token type")

    user_id = uuid.UUID(str(payload["sub"]))
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found")

    access = create_access_token(user_id=user.id, email=user.email, role=user.role.value)
    settings = get_settings()
    is_prod = settings.app_env == "production"
    response.set_cookie(
        "access_token",
        access,
        httponly=True,
        secure=is_prod,
        samesite="lax",
        max_age=settings.jwt_access_ttl_min * 60,
        path="/",
    )
    return {"access_token": access, "token_type": "bearer"}

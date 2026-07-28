"""
Authentication endpoints.

Endpoints:
  POST /api/auth/login            – email + password → access/refresh tokens
  POST /api/auth/logout           – clears auth cookies
  GET  /api/auth/me               – returns current user
  POST /api/auth/refresh          – rotates access token using refresh cookie
  POST /api/auth/change-password  – changes the current user's password
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
    hash_password,
    password_policy_error,
    verify_password,
)
from app.db.session import get_db
from app.models import ActivityAction, ActivityLog, User
from app.schemas.auth import (
    ChangePasswordRequest,
    ChangePasswordResponse,
    LoginRequest,
    TokenResponse,
)
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


def _clear_auth_cookies(response: Response) -> None:
    settings = get_settings()
    is_prod = settings.app_env == "production"
    response.delete_cookie(
        "access_token", path="/", httponly=True, secure=is_prod, samesite="lax"
    )
    response.delete_cookie(
        "refresh_token", path="/", httponly=True, secure=is_prod, samesite="lax"
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

    if user is None or not verify_password(payload.password, user.password_hash):
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
    _clear_auth_cookies(response)
    return {"ok": True, "user_id": str(user.id)}


@router.post("/change-password", response_model=ChangePasswordResponse)
async def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChangePasswordResponse:
    """Change only the authenticated user's password and end the current session."""
    result = await db.execute(
        select(User).where(User.id == user.id).with_for_update()
    )
    locked_user = result.scalar_one_or_none()
    if locked_user is None:
        raise HTTPException(status_code=401, detail="User not found")

    if not verify_password(payload.current_password, locked_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")

    if payload.new_password != payload.confirm_password:
        raise HTTPException(
            status_code=400,
            detail="New password and confirmation do not match.",
        )

    if verify_password(payload.new_password, locked_user.password_hash):
        raise HTTPException(
            status_code=400,
            detail="New password cannot be the same as the current password.",
        )

    policy_error = password_policy_error(payload.new_password)
    if policy_error:
        raise HTTPException(status_code=400, detail=policy_error)

    locked_user.password_hash = hash_password(payload.new_password)
    db.add(
        ActivityLog(
            actor_id=locked_user.id,
            action=ActivityAction.PASSWORD_CHANGED,
            entity_type="user",
            entity_id=locked_user.id,
            payload={
                "ip": request.client.host if request.client else None,
                "scope": "self_service",
            },
        )
    )
    await db.commit()

    _clear_auth_cookies(response)
    log.info("Password changed for user %s", locked_user.id)
    return ChangePasswordResponse(
        message="Password changed successfully. Sign in using your new password."
    )


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
    if user is None:
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

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
from datetime import datetime, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.core.net import client_ip, user_agent as request_user_agent
from app.core.security import (
    TOKEN_TYPE_REFRESH,
    create_access_token,
    create_refresh_token,
    decode_token,
    verify_password,
)
from app.db.session import get_db
from app.models import ActivityAction, ActivityLog, User, UserSession
from app.schemas.auth import LoginRequest, TokenResponse
from app.schemas.user import UserPublic

log = logging.getLogger("davangere.auth")
router = APIRouter()


def _set_auth_cookies(response: Response, access: str, refresh: str, session_id: uuid.UUID) -> None:
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
    # Tracks *this* login for duration/IP reporting; lives as long as the
    # refresh token so it survives access-token rotation via /refresh.
    response.set_cookie(
        "session_id",
        str(session_id),
        httponly=True,
        secure=is_prod,
        samesite="lax",
        max_age=settings.jwt_refresh_ttl_days * 86400,
        path="/",
    )


async def _find_open_session(
    db: AsyncSession, request: Request, user_id: uuid.UUID
) -> UserSession | None:
    """Resolve the caller's session row: prefer the session_id cookie set at
    login, and fall back to the user's most recent open session (covers
    Bearer-token clients, or a login that predates this cookie)."""
    cookie = request.cookies.get("session_id")
    if cookie:
        try:
            session_uuid = uuid.UUID(cookie)
        except ValueError:
            session_uuid = None
        if session_uuid is not None:
            result = await db.execute(
                select(UserSession).where(
                    UserSession.id == session_uuid, UserSession.user_id == user_id
                )
            )
            session = result.scalar_one_or_none()
            if session is not None:
                return session

    result = await db.execute(
        select(UserSession)
        .where(UserSession.user_id == user_id, UserSession.logout_at.is_(None))
        .order_by(UserSession.login_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


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

    ip = client_ip(request)
    ua = request_user_agent(request)

    access = create_access_token(user_id=user.id, email=user.email, role=user.role.value)
    refresh = create_refresh_token(user_id=user.id)
    session_id = uuid.uuid4()
    _set_auth_cookies(response, access, refresh, session_id)

    db.add(UserSession(id=session_id, user_id=user.id, ip_address=ip, user_agent=ua))
    db.add(
        ActivityLog(
            actor_id=user.id,
            action=ActivityAction.LOGIN,
            entity_type="user",
            entity_id=user.id,
            payload={"ip": ip, "user_agent": ua},
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
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    session = await _find_open_session(db, request, user.id)
    if session is not None and session.logout_at is None:
        now = datetime.now(timezone.utc)
        duration_seconds = round((now - session.login_at).total_seconds())
        session.logout_at = now
        session.last_seen_at = now
        db.add(
            ActivityLog(
                actor_id=user.id,
                action=ActivityAction.LOGOUT,
                entity_type="user",
                entity_id=user.id,
                payload={"ip": client_ip(request), "duration_seconds": duration_seconds},
            )
        )
        await db.commit()

    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    response.delete_cookie("session_id", path="/")
    return {"ok": True, "user_id": str(user.id)}


@router.post("/heartbeat")
async def heartbeat(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Called periodically by the frontend while a tab is open so
    "active users" / session duration stay accurate for people who close
    the tab instead of clicking Logout."""
    session = await _find_open_session(db, request, user.id)
    if session is not None and session.logout_at is None:
        session.last_seen_at = datetime.now(timezone.utc)
        await db.commit()
    return {"ok": True}


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

"""Isolated public/citizen registration and authentication endpoints."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.public_deps import get_current_public_user
from app.core.config import get_settings
from app.core.net import client_ip, user_agent as request_user_agent
from app.core.public_security import (
    PUBLIC_TOKEN_TYPE_REFRESH,
    create_public_access_token,
    create_public_refresh_token,
    decode_public_token,
    generate_otp,
    otp_digest,
    verify_otp_digest,
)
from app.core.security import hash_password, password_policy_error, verify_password
from app.db.session import get_db
from app.models.public_portal import PublicOtpChallenge, PublicOtpPurpose, PublicSession, PublicUser
from app.schemas.public_portal import (
    PublicLoginRequest,
    PublicOtpRequest,
    PublicOtpRequestOut,
    PublicOtpVerifyOut,
    PublicOtpVerifyRequest,
    PublicRegisterRequest,
    PublicTokenResponse,
    PublicUserOut,
    PublicUsernameAvailabilityOut,
)
from app.services.public_otp import deliver_registration_otp, mask_email

router = APIRouter()
_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,62}[a-z0-9]$")


def registration_token_digest(challenge_id: uuid.UUID, token: str) -> str:
    """Return a server-keyed digest for a one-time registration token."""
    secret = get_settings().jwt_secret.encode("utf-8")
    message = f"{challenge_id}:{token}".encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def normalize_phone(value: str) -> str:
    digits = "".join(ch for ch in value if ch.isdigit())
    if len(digits) == 10:
        return f"+91{digits}"
    if 11 <= len(digits) <= 15:
        return f"+{digits}"
    raise HTTPException(status_code=422, detail="Enter a valid phone number")


def normalize_email(value: str) -> str:
    return value.strip().lower()


def normalize_username(value: str) -> str:
    username = value.strip().lower()
    if not _USERNAME_RE.fullmatch(username):
        raise HTTPException(
            status_code=422,
            detail="Username must be 4-64 characters using lowercase letters, numbers, dot, underscore, or hyphen.",
        )
    return username


def set_public_cookies(response: Response, access: str, refresh: str, session_id: uuid.UUID) -> None:
    settings = get_settings()
    secure = settings.app_env == "production"
    common = {"httponly": True, "secure": secure, "samesite": "lax", "path": "/"}
    response.set_cookie("public_access_token", access, max_age=settings.jwt_access_ttl_min * 60, **common)
    response.set_cookie("public_refresh_token", refresh, max_age=settings.jwt_refresh_ttl_days * 86400, **common)
    response.set_cookie("public_session_id", str(session_id), max_age=settings.jwt_refresh_ttl_days * 86400, **common)


def clear_public_cookies(response: Response) -> None:
    settings = get_settings()
    secure = settings.app_env == "production"
    common = {"httponly": True, "secure": secure, "samesite": "lax", "path": "/"}
    for name in ("public_access_token", "public_refresh_token", "public_session_id"):
        response.delete_cookie(name, **common)


async def create_session(
    *,
    db: AsyncSession,
    request: Request,
    user: PublicUser,
    screen_width: int | None,
    screen_height: int | None,
) -> tuple[PublicSession, str, str]:
    session = PublicSession(
        public_user_id=user.id,
        ip_address=client_ip(request),
        user_agent=request_user_agent(request),
        screen_width=screen_width,
        screen_height=screen_height,
    )
    db.add(session)
    await db.flush()
    return (
        session,
        create_public_access_token(user_id=user.id, username=user.username),
        create_public_refresh_token(user_id=user.id),
    )


@router.get("/username-availability", response_model=PublicUsernameAvailabilityOut)
async def username_availability(
    username: str = Query(min_length=4, max_length=64),
    db: AsyncSession = Depends(get_db),
) -> PublicUsernameAvailabilityOut:
    normalized = normalize_username(username)
    exists = await db.scalar(select(func.count()).select_from(PublicUser).where(PublicUser.username == normalized))
    return PublicUsernameAvailabilityOut(username=normalized, available=not bool(exists))


@router.post("/request-otp", response_model=PublicOtpRequestOut)
async def request_otp(
    payload: PublicOtpRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> PublicOtpRequestOut:
    settings = get_settings()
    phone = normalize_phone(payload.phone)
    email = normalize_email(str(payload.email))

    existing_user = await db.scalar(
        select(PublicUser.id).where(
            (PublicUser.phone == phone) | (func.lower(PublicUser.email) == email)
        )
    )
    if existing_user is not None:
        raise HTTPException(
            status_code=409,
            detail="A public account already exists with this email address or phone number. Use Public Login to sign in.",
        )

    now = datetime.now(timezone.utc)
    latest = (
        await db.execute(
            select(PublicOtpChallenge)
            .where(func.lower(PublicOtpChallenge.email) == email)
            .order_by(PublicOtpChallenge.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if latest is not None:
        elapsed = (now - latest.created_at).total_seconds()
        if elapsed < settings.public_otp_resend_seconds:
            wait = max(1, int(settings.public_otp_resend_seconds - elapsed))
            raise HTTPException(status_code=429, detail=f"Please wait {wait} seconds before requesting another OTP")

    challenge = PublicOtpChallenge(
        phone=phone,
        email=email,
        purpose=PublicOtpPurpose.REGISTER,
        code_hash="pending",
        expires_at=now + timedelta(minutes=settings.public_otp_ttl_minutes),
        request_ip=client_ip(request),
    )
    db.add(challenge)
    await db.flush()

    code = generate_otp()
    challenge.code_hash = otp_digest(challenge.id, code)
    try:
        await deliver_registration_otp(email=email, phone=phone, code=code)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="Unable to send email OTP. Please try again later.") from exc

    return PublicOtpRequestOut(
        challenge_id=challenge.id,
        expires_at=challenge.expires_at,
        resend_after_seconds=settings.public_otp_resend_seconds,
        masked_email=mask_email(email),
        debug_otp=(
            code
            if settings.app_env != "production" and settings.public_otp_mode.lower() == "development"
            else None
        ),
    )


@router.post("/verify-otp", response_model=PublicOtpVerifyOut)
async def verify_registration_otp(
    payload: PublicOtpVerifyRequest,
    db: AsyncSession = Depends(get_db),
) -> PublicOtpVerifyOut:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    challenge = (
        await db.execute(
            select(PublicOtpChallenge)
            .where(PublicOtpChallenge.id == payload.challenge_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if challenge is None or challenge.purpose != PublicOtpPurpose.REGISTER:
        raise HTTPException(status_code=404, detail="OTP challenge not found")
    if challenge.consumed_at is not None:
        raise HTTPException(status_code=409, detail="This OTP has already been used")
    if challenge.verified_at is not None:
        raise HTTPException(status_code=409, detail="Email OTP is already verified. Continue account setup or request a new OTP")
    if challenge.expires_at <= now:
        raise HTTPException(status_code=410, detail="OTP has expired. Request a new OTP")
    if challenge.attempts >= settings.public_otp_max_attempts:
        raise HTTPException(status_code=429, detail="Too many incorrect OTP attempts")

    if not verify_otp_digest(challenge.id, payload.otp, challenge.code_hash):
        challenge.attempts += 1
        # Persist the failed-attempt counter before returning.
        await db.commit()
        raise HTTPException(status_code=400, detail="Incorrect OTP")

    if not challenge.email:
        raise HTTPException(status_code=409, detail="This OTP was not issued for email registration. Request a new OTP")

    registration_token = secrets.token_urlsafe(48)
    token_expires_at = now + timedelta(minutes=settings.public_registration_token_ttl_minutes)
    challenge.verified_at = now
    challenge.registration_token_hash = registration_token_digest(challenge.id, registration_token)
    challenge.registration_token_expires_at = token_expires_at

    return PublicOtpVerifyOut(
        challenge_id=challenge.id,
        registration_token=registration_token,
        registration_token_expires_at=token_expires_at,
        masked_email=mask_email(challenge.email),
    )


@router.post("/register", response_model=PublicTokenResponse)
async def register(
    payload: PublicRegisterRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> PublicTokenResponse:
    now = datetime.now(timezone.utc)
    challenge = (
        await db.execute(
            select(PublicOtpChallenge)
            .where(PublicOtpChallenge.id == payload.challenge_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if challenge is None or challenge.purpose != PublicOtpPurpose.REGISTER:
        raise HTTPException(status_code=404, detail="OTP challenge not found")
    if challenge.consumed_at is not None:
        raise HTTPException(status_code=409, detail="This registration link has already been used")
    if challenge.verified_at is None:
        raise HTTPException(status_code=403, detail="Verify the email OTP before creating a password")
    if (
        challenge.registration_token_expires_at is None
        or challenge.registration_token_expires_at <= now
    ):
        raise HTTPException(status_code=410, detail="Verified registration session expired. Request a new OTP")
    if not challenge.registration_token_hash or not hmac.compare_digest(
        registration_token_digest(challenge.id, payload.registration_token),
        challenge.registration_token_hash,
    ):
        raise HTTPException(status_code=403, detail="Invalid verified registration session")

    if payload.password != payload.confirm_password:
        raise HTTPException(status_code=400, detail="Password and confirmation do not match")
    policy_error = password_policy_error(payload.password)
    if policy_error:
        raise HTTPException(status_code=400, detail=policy_error.replace("New password", "Password"))

    if not challenge.email:
        raise HTTPException(status_code=409, detail="This OTP was not issued for email registration. Request a new OTP")

    email = normalize_email(challenge.email)
    username = normalize_username(payload.username)
    collision = await db.scalar(
        select(func.count()).select_from(PublicUser).where(
            (PublicUser.username == username)
            | (PublicUser.phone == challenge.phone)
            | (func.lower(PublicUser.email) == email)
        )
    )
    if collision:
        raise HTTPException(
            status_code=409,
            detail="An account already exists with this username, email address, or phone number. Use Public Login to sign in.",
        )

    user = PublicUser(
        first_name=payload.first_name,
        last_name=payload.last_name,
        phone=challenge.phone,
        email=email,
        username=username,
        password_hash=hash_password(payload.password),
        phone_verified_at=None,
        email_verified_at=now,
        registration_latitude=None,
        registration_longitude=None,
        registration_accuracy_m=None,
        registration_location_label=None,
        registration_ip=client_ip(request),
        registration_user_agent=request_user_agent(request),
    )
    db.add(user)
    challenge.consumed_at = now
    challenge.registration_token_hash = None
    challenge.registration_token_expires_at = None
    try:
        await db.flush()
    except IntegrityError as exc:
        # A concurrent registration may win after the availability check.
        # Roll back the failed transaction and return a stable conflict rather
        # than leaking a database integrity error to the public client.
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="An account already exists with this username, email address, or phone number. Use Public Login to sign in.",
        ) from exc

    session, access, refresh = await create_session(
        db=db,
        request=request,
        user=user,
        screen_width=payload.screen_width,
        screen_height=payload.screen_height,
    )
    set_public_cookies(response, access, refresh, session.id)
    return PublicTokenResponse(access_token=access, refresh_token=refresh, user=PublicUserOut.model_validate(user))


@router.post("/login", response_model=PublicTokenResponse)
async def login(
    payload: PublicLoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> PublicTokenResponse:
    identifier = payload.username.strip().lower()
    user = (
        await db.execute(
            select(PublicUser).where(
                (PublicUser.username == identifier) | (func.lower(PublicUser.email) == identifier)
            )
        )
    ).scalar_one_or_none()
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid public username/email or password")

    session, access, refresh = await create_session(
        db=db,
        request=request,
        user=user,
        screen_width=payload.screen_width,
        screen_height=payload.screen_height,
    )
    set_public_cookies(response, access, refresh, session.id)
    return PublicTokenResponse(access_token=access, refresh_token=refresh, user=PublicUserOut.model_validate(user))


@router.get("/me", response_model=PublicUserOut)
async def me(user: PublicUser = Depends(get_current_public_user)) -> PublicUserOut:
    return PublicUserOut.model_validate(user)


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    cookie = request.cookies.get("public_session_id")
    if cookie:
        try:
            session_id = uuid.UUID(cookie)
        except ValueError:
            session_id = None
        if session_id is not None:
            session = (
                await db.execute(
                    select(PublicSession).where(
                        PublicSession.id == session_id,
                        PublicSession.public_user_id == user.id,
                    )
                )
            ).scalar_one_or_none()
            if session is not None and session.logout_at is None:
                session.logout_at = datetime.now(timezone.utc)
                session.last_seen_at = session.logout_at
    clear_public_cookies(response)
    return {"ok": True}


@router.post("/refresh")
async def refresh(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    token = request.cookies.get("public_refresh_token")
    if not token:
        raise HTTPException(status_code=401, detail="Missing public refresh token")
    try:
        payload = decode_public_token(token)
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Public refresh token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid public refresh token") from exc
    if payload.get("type") != PUBLIC_TOKEN_TYPE_REFRESH or payload.get("role") != "public":
        raise HTTPException(status_code=401, detail="Invalid public refresh token type")
    try:
        user_id = uuid.UUID(str(payload["sub"]))
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="Malformed public token") from exc
    user = await db.scalar(select(PublicUser).where(PublicUser.id == user_id, PublicUser.is_active.is_(True)))
    if user is None:
        raise HTTPException(status_code=401, detail="Public account not found")

    session_cookie = request.cookies.get("public_session_id")
    try:
        session_id = uuid.UUID(session_cookie) if session_cookie else None
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid public session") from exc
    if session_id is None:
        raise HTTPException(status_code=401, detail="Missing public session")
    session = await db.scalar(
        select(PublicSession).where(
            PublicSession.id == session_id,
            PublicSession.public_user_id == user.id,
            PublicSession.logout_at.is_(None),
        )
    )
    if session is None:
        raise HTTPException(status_code=401, detail="Public session is no longer active")
    session.last_seen_at = datetime.now(timezone.utc)

    access = create_public_access_token(user_id=user.id, username=user.username)
    response.set_cookie(
        "public_access_token",
        access,
        httponly=True,
        secure=get_settings().app_env == "production",
        samesite="lax",
        max_age=get_settings().jwt_access_ttl_min * 60,
        path="/",
    )
    return {"access_token": access, "token_type": "bearer"}

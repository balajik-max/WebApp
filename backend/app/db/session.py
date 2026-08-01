"""Async engine + session factory + FastAPI dependency.

Multi-database routing:
- Main engine: Auth database (users table) for authentication
- Role engines: Separate databases per role for data isolation
"""
from __future__ import annotations

from typing import AsyncGenerator

import jwt
from fastapi import Request
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy import text

from app.core.config import get_settings


_settings = get_settings()

# Main engine for auth database (shared users table)
auth_engine = create_async_engine(
    _settings.database_url,
    echo=False,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    future=True,
)

AuthSessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=auth_engine,
    expire_on_commit=False,
    class_=AsyncSession,
)

# Role-specific engines (created lazily on first use)
_role_engines: dict[str, any] = {}
_role_sessions: dict[str, async_sessionmaker[AsyncSession]] = {}

# Map UserRole enum values to database URLs
_ROLE_DB_MAP: dict[str, str] = {}


def _init_role_db_map() -> None:
    """Initialize the role-to-database mapping from config."""
    global _ROLE_DB_MAP
    if _ROLE_DB_MAP:
        return

    _ROLE_DB_MAP = {
        "admin": _settings.db_admin or _settings.database_url,
        "architect": _settings.db_architect or _settings.database_url,
        "commissioner": _settings.db_commissioner or _settings.database_url,
        "aee": _settings.db_aee or _settings.database_url,
        "ae": _settings.db_ae or _settings.database_url,
        "mla": _settings.db_mla or _settings.database_url,
    }


def _get_role_engine(role: str):
    """Get or create an async engine for a specific role's database."""
    _init_role_db_map()

    db_url = _ROLE_DB_MAP.get(role, _settings.database_url)

    if role not in _role_engines:
        _role_engines[role] = create_async_engine(
            db_url,
            echo=False,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
            future=True,
        )
        _role_sessions[role] = async_sessionmaker(
            bind=_role_engines[role],
            expire_on_commit=False,
            class_=AsyncSession,
        )

    return _role_engines[role]


def _get_role_session_factory(role: str) -> async_sessionmaker[AsyncSession]:
    """Get the session factory for a specific role's database."""
    _get_role_engine(role)
    return _role_sessions[role]


def _extract_role_from_request(request: Request) -> str | None:
    """Extract user role from JWT token in request without querying DB."""
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        return None
    try:
        payload = jwt.decode(token, _settings.jwt_secret, algorithms=[_settings.jwt_algorithm])
        return payload.get("role")
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None


async def get_auth_db() -> AsyncGenerator[AsyncSession, None]:
    """Get a session for the auth database (users table)."""
    async with AuthSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()


async def get_db_by_role(role: str) -> AsyncGenerator[AsyncSession, None]:
    """Get a session for a role-specific database."""
    session_factory = _get_role_session_factory(role)
    async with session_factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()


async def get_db(request: Request) -> AsyncGenerator[AsyncSession, None]:
    """Get a database session — automatically routes to the user's role database.

    Extracts the role from the JWT token in the request cookie/header
    and routes to the corresponding role-specific database.
    Falls back to the auth database if no token is present.
    """
    role = _extract_role_from_request(request)
    if role:
        async for session in get_db_by_role(role):
            yield session
    else:
        async for session in get_auth_db():
            yield session


async def init_role_databases() -> None:
    """Create tables in all role-specific databases."""
    from app.db.base import Base
    from app.models import User, UserRole

    _init_role_db_map()

    for role, db_url in _ROLE_DB_MAP.items():
        if db_url == _settings.database_url:
            # Skip the main auth database (already initialized)
            continue

        engine = create_async_engine(db_url, echo=False)
        async with engine.begin() as conn:
            # Create all tables
            await conn.run_sync(Base.metadata.create_all)
        await engine.dispose()


# Backward-compatible aliases for existing code that imports SessionLocal/engine
SessionLocal = AuthSessionLocal
engine = auth_engine

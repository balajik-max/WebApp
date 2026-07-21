"""
Standalone database seeder.

Usage (any of):
    python backend/seed.py                 # local host, with backend/.env loaded
    docker compose run --rm backend python seed.py
    docker compose exec backend python seed.py

Idempotent:
  * Creates the seeded users (admin, architect, commissioner) if missing.
  * Rotates their bcrypt hash if the plaintext password in `.env` has changed.
  * Leaves any other users untouched.
  * Emits an ActivityLog row (`USER_CREATED`) only for newly-inserted rows.

This script *only* seeds — schema creation and spatial indexes are handled
by `app.db.init_db.init_database()` which the FastAPI lifespan calls on
boot.  Running the seeder against an empty database will implicitly call
`init_database()` first so it can also be used as a one-shot bootstrap.
"""
from __future__ import annotations

import asyncio
import logging
import sys
from typing import Iterable

from dotenv import load_dotenv

# Ensure `.env` is loaded before importing any settings-consuming modules.
load_dotenv()

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.core.logging import configure_logging  # noqa: E402
from app.core.security import hash_password, verify_password  # noqa: E402
from app.db.init_db import init_database  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.models import ActivityAction, ActivityLog, User, UserRole  # noqa: E402


log = logging.getLogger("davangere.seed")


class SeedSpec:
    __slots__ = ("email", "password", "name", "role")

    def __init__(self, *, email: str, password: str, name: str, role: UserRole) -> None:
        self.email = email.strip().lower()
        self.password = password
        self.name = name
        self.role = role


async def _upsert_user(session: AsyncSession, spec: SeedSpec) -> tuple[User, bool]:
    """Insert the user if missing; rotate the bcrypt hash if the password changed.

    Returns (user, created).  `created` is True only when the row was inserted
    in this transaction.
    """
    result = await session.execute(select(User).where(User.email == spec.email))
    existing = result.scalar_one_or_none()

    if existing is None:
        user = User(
            email=spec.email,
            password_hash=hash_password(spec.password),
            name=spec.name,
            role=spec.role,
        )
        session.add(user)
        await session.flush()
        session.add(
            ActivityLog(
                actor_id=user.id,
                action=ActivityAction.USER_CREATED,
                entity_type="user",
                entity_id=user.id,
                payload={"email": user.email, "role": user.role.value, "source": "seed"},
            )
        )
        log.info("Seeded %s user %s", spec.role.value, spec.email)
        return user, True

    if not verify_password(spec.password, existing.password_hash):
        existing.password_hash = hash_password(spec.password)
        log.info("Rotated password for %s", spec.email)

    # Keep name & role in sync with env-declared source of truth.
    if existing.name != spec.name:
        existing.name = spec.name
    if existing.role != spec.role:
        existing.role = spec.role
    existing.is_active = True

    return existing, False


async def _seed(specs: Iterable[SeedSpec]) -> None:
    async with SessionLocal() as session:
        for spec in specs:
            await _upsert_user(session, spec)
        await session.commit()


async def main() -> int:
    settings = get_settings()
    configure_logging(settings.log_level)

    # Ensure schema + spatial indexes exist before seeding.
    log.info("Preparing schema (idempotent)…")
    await init_database()

    specs = [
        SeedSpec(
            email=settings.mla_email,
            password=settings.mla_password,
            name=settings.mla_name,
            role=UserRole.MLA,
        ),
        SeedSpec(
            email=settings.commissioner_email,
            password=settings.commissioner_password,
            name=settings.commissioner_name,
            role=UserRole.COMMISSIONER,
        ),
        SeedSpec(
            email=settings.aee_email,
            password=settings.aee_password,
            name=settings.aee_name,
            role=UserRole.AEE,
        ),
        SeedSpec(
            email=settings.ae_email,
            password=settings.ae_password,
            name=settings.ae_name,
            role=UserRole.AE,
        ),
    ]

    await _seed(specs)
    log.info("Seed complete: %d user(s) verified.", len(specs))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

"""Regression tests for self-service password changes."""
from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi import HTTPException, Request, Response

from app.api.v1.auth import change_password
from app.core.security import hash_password, password_policy_error, verify_password
from app.models import ActivityAction, ActivityLog, User, UserRole
from app.schemas.auth import ChangePasswordRequest
from seed import SeedSpec, _upsert_user


class _ScalarResult:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class _FakeSession:
    def __init__(self, value):
        self.value = value
        self.added: list[object] = []
        self.commits = 0
        self.flushes = 0

    async def execute(self, _statement):
        return _ScalarResult(self.value)

    def add(self, value):
        self.added.append(value)

    async def commit(self):
        self.commits += 1

    async def flush(self):
        self.flushes += 1


def _request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/change-password",
            "headers": [],
            "client": ("127.0.0.1", 12345),
            "scheme": "http",
            "server": ("testserver", 80),
        }
    )


def _user(password: str = "Current@123") -> User:
    return User(
        id=uuid.uuid4(),
        email="ae@davangere.gov.in",
        name="AE",
        role=UserRole.AE,
        is_active=True,
        password_hash=hash_password(password),
    )


def test_password_policy_accepts_strong_password() -> None:
    assert password_policy_error("NewSecure@123") is None


@pytest.mark.parametrize(
    "password",
    ["Short1!", "nouppercase1!", "NOLOWERCASE1!", "NoNumber!", "NoSpecial123"],
)
def test_password_policy_rejects_weak_password(password: str) -> None:
    assert password_policy_error(password) is not None


def test_change_password_updates_hash_logs_activity_and_clears_cookies() -> None:
    user = _user()
    session = _FakeSession(user)
    response = Response()

    result = asyncio.run(
        change_password(
            payload=ChangePasswordRequest(
                current_password="Current@123",
                new_password="NewSecure@123",
                confirm_password="NewSecure@123",
            ),
            request=_request(),
            response=response,
            user=user,
            db=session,
        )
    )

    assert result.ok is True
    assert verify_password("NewSecure@123", user.password_hash) is True
    assert verify_password("Current@123", user.password_hash) is False
    assert session.commits == 1
    logs = [item for item in session.added if isinstance(item, ActivityLog)]
    assert len(logs) == 1
    assert logs[0].action == ActivityAction.PASSWORD_CHANGED
    cookies = " ".join(response.headers.getlist("set-cookie")).lower()
    assert "access_token=" in cookies and "refresh_token=" in cookies
    assert "max-age=0" in cookies


def test_change_password_rejects_wrong_current_password() -> None:
    user = _user()
    session = _FakeSession(user)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            change_password(
                payload=ChangePasswordRequest(
                    current_password="Wrong@123",
                    new_password="NewSecure@123",
                    confirm_password="NewSecure@123",
                ),
                request=_request(),
                response=Response(),
                user=user,
                db=session,
            )
        )

    assert exc.value.status_code == 400
    assert session.commits == 0
    assert verify_password("Current@123", user.password_hash) is True


def test_change_password_rejects_mismatch_and_reuse() -> None:
    user = _user()
    session = _FakeSession(user)

    for payload, expected in [
        (
            ChangePasswordRequest(
                current_password="Current@123",
                new_password="NewSecure@123",
                confirm_password="Different@123",
            ),
            "do not match",
        ),
        (
            ChangePasswordRequest(
                current_password="Current@123",
                new_password="Current@123",
                confirm_password="Current@123",
            ),
            "same as the current",
        ),
    ]:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                change_password(
                    payload=payload,
                    request=_request(),
                    response=Response(),
                    user=user,
                    db=session,
                )
            )
        assert expected in str(exc.value.detail)

    assert session.commits == 0


def test_seed_preserves_password_changed_in_database() -> None:
    existing = _user(password="UserChanged@123")
    original_hash = existing.password_hash
    session = _FakeSession(existing)

    returned, created = asyncio.run(
        _upsert_user(
            session,
            SeedSpec(
                email=existing.email,
                password="Environment@123",
                name="Assistant Engineer",
                role=UserRole.AE,
            ),
        )
    )

    assert created is False
    assert returned is existing
    assert existing.password_hash == original_hash
    assert verify_password("UserChanged@123", existing.password_hash) is True
    assert verify_password("Environment@123", existing.password_hash) is False
    assert existing.name == "Assistant Engineer"

"""Regression coverage for the isolated public/citizen module."""
from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime, timezone

from app.api.v1.public_auth import normalize_email, normalize_phone, normalize_username
from app.api.v1.public_complaints import officer_complaint_detail
from app.models import NotificationSource, User, UserRole
from app.models.public_portal import (
    PublicComplaint,
    PublicComplaintStatus,
    PublicNotification,
    PublicUser,
)


class _ScalarResult:
    def __init__(self, value):
        self.value = value

    def unique(self):
        return self

    def scalar_one_or_none(self):
        return self.value


class _FakeSession:
    def __init__(self, complaint: PublicComplaint):
        self.complaint = complaint
        self.added: list[object] = []
        self.flushes = 0

    async def execute(self, statement):
        return _ScalarResult(self.complaint)

    def add(self, value):
        self.added.append(value)

    async def flush(self):
        self.flushes += 1


def _public_user() -> PublicUser:
    now = datetime.now(timezone.utc)
    return PublicUser(
        id=uuid.uuid4(),
        first_name="Public",
        last_name="User",
        date_of_birth=date(1990, 1, 1),
        phone="+919999999999",
        email="public.user@example.com",
        username="public.user",
        password_hash="not-used",
        is_active=True,
        phone_verified_at=now,
        created_at=now,
        updated_at=now,
    )


def _complaint(owner: PublicUser) -> PublicComplaint:
    now = datetime.now(timezone.utc)
    row = PublicComplaint(
        id=uuid.uuid4(),
        public_user_id=owner.id,
        title="Drain overflow",
        description="Drain water is overflowing beside the public road.",
        status=PublicComplaintStatus.SUBMITTED,
        image_key="public-complaints/test.jpg",
        image_filename="test.jpg",
        image_content_type="image/jpeg",
        latitude=14.4644,
        longitude=75.9218,
        created_at=now,
        updated_at=now,
    )
    row.public_user = owner
    return row


def _officer(role: UserRole) -> User:
    return User(
        id=uuid.uuid4(),
        name=role.value.upper(),
        email=f"{role.value}@davangere.gov.in",
        password_hash="not-used",
        role=role,
        is_active=True,
    )


def test_public_identity_normalization_is_separate_from_officer_email_login() -> None:
    assert normalize_phone("98765 43210") == "+919876543210"
    assert normalize_phone("+91-98765-43210") == "+919876543210"
    assert normalize_email(" Citizen.User@Example.COM ") == "citizen.user@example.com"
    assert normalize_username(" Citizen.User ") == "citizen.user"
    assert NotificationSource.PUBLIC_COMPLAINT_SUBMITTED.value == "public_complaint_submitted"


def test_commissioner_view_notifies_public_user_exactly_once() -> None:
    owner = _public_user()
    complaint = _complaint(owner)
    session = _FakeSession(complaint)
    commissioner = _officer(UserRole.COMMISSIONER)

    first = asyncio.run(
        officer_complaint_detail(
            complaint_id=complaint.id,
            current_user=commissioner,
            db=session,
        )
    )
    second = asyncio.run(
        officer_complaint_detail(
            complaint_id=complaint.id,
            current_user=commissioner,
            db=session,
        )
    )

    public_updates = [row for row in session.added if isinstance(row, PublicNotification)]
    assert len(public_updates) == 1
    assert public_updates[0].message == "Authority viewed your problem."
    assert complaint.status == PublicComplaintStatus.VIEWED_BY_COMMISSIONER
    assert complaint.commissioner_viewed_by == commissioner.id
    assert first.commissioner_viewed_at is not None
    assert second.commissioner_viewed_at == first.commissioner_viewed_at


def test_ae_view_marks_received_without_commissioner_message() -> None:
    owner = _public_user()
    complaint = _complaint(owner)
    session = _FakeSession(complaint)

    asyncio.run(
        officer_complaint_detail(
            complaint_id=complaint.id,
            current_user=_officer(UserRole.AE),
            db=session,
        )
    )

    assert complaint.status == PublicComplaintStatus.RECEIVED
    assert not any(isinstance(row, PublicNotification) for row in session.added)

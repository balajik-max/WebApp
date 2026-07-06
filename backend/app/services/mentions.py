"""
@mention parsing + inbox writer.

Convention: usernames are the local-part of a user's email address (case
insensitive).  So `admin@davangere.gov.in` is `@admin` and
`architect@davangere.gov.in` is `@architect`.  Unknown handles are
silently ignored — a comment with a typo shouldn't 500.
"""
from __future__ import annotations

import re
import uuid
from typing import Iterable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Notification, NotificationSource, User

_MENTION_RE = re.compile(r"@([A-Za-z0-9_.+\-]{2,64})")


def extract_mentions(text: str) -> list[str]:
    if not text:
        return []
    return list({m.lower() for m in _MENTION_RE.findall(text)})


async def resolve_users(db: AsyncSession, handles: Iterable[str]) -> list[User]:
    handles = [h.lower() for h in handles]
    if not handles:
        return []
    stmt = select(User).where(
        func.lower(func.split_part(User.email, "@", 1)).in_(handles)
    )
    return list((await db.execute(stmt)).scalars().all())


async def notify_mentions(
    db: AsyncSession,
    *,
    body: str,
    actor_id: uuid.UUID,
    comment_id: uuid.UUID,
    feature_id: uuid.UUID | None,
) -> list[Notification]:
    """Parse `body`, resolve @handles → users, insert notification rows.

    Returns the list of created rows (empty if no valid mentions).
    """
    handles = extract_mentions(body)
    if not handles:
        return []

    users = await resolve_users(db, handles)
    created: list[Notification] = []
    for user in users:
        if user.id == actor_id:
            continue  # don't ping yourself
        row = Notification(
            user_id=user.id,
            actor_id=actor_id,
            source=NotificationSource.COMMENT_MENTION,
            source_id=comment_id,
            feature_id=feature_id,
            message=(body[:280] + "…") if len(body) > 280 else body,
        )
        db.add(row)
        created.append(row)
    return created

"""
Immutable activity logging helper.

Any status change, assignment, or upload should call `record_activity(...)`
so the audit trail in `activity_log` is populated automatically without
scattering ORM inserts across the codebase.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ActivityAction, ActivityLog


async def record_activity(
    db: AsyncSession,
    *,
    action: ActivityAction,
    actor_id: uuid.UUID | None = None,
    entity_type: str | None = None,
    entity_id: uuid.UUID | None = None,
    payload: dict[str, Any] | None = None,
) -> ActivityLog:
    row = ActivityLog(
        actor_id=actor_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        payload=payload or {},
    )
    db.add(row)
    await db.flush()
    return row

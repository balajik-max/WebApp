"""Client-driven activity logging.

Endpoints:
  POST /api/v1/activity/log - records a client-side interaction (page view,
  map zoom/pan, layer selection, dataset load, etc.) into the same
  activity_log audit trail the admin Users & Activity event log reads from.

Only a fixed, server-defined subset of ActivityAction values may be written
here (see ClientLoggableAction below) — everything else in that enum is
written exclusively by trusted server-side business logic elsewhere in the
API, and must never become spoofable through a client-postable endpoint.
"""
from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import ActivityAction, User
from app.services.activity import record_activity

router = APIRouter()

ClientLoggableAction = Literal[
    "page_viewed",
    "map_interacted",
    "data_layers_opened",
    "dataset_loaded",
    "ai_detection_selected",
    "map_3d_viewed",
]

_MAX_PAYLOAD_KEYS = 10
_MAX_PAYLOAD_BYTES = 2000


class ClientActivityRequest(BaseModel):
    action: ClientLoggableAction
    entity_type: str | None = Field(default=None, max_length=64)
    payload: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

    @field_validator("payload")
    @classmethod
    def _cap_payload(cls, value: dict) -> dict:
        if len(value) > _MAX_PAYLOAD_KEYS or len(json.dumps(value)) > _MAX_PAYLOAD_BYTES:
            raise ValueError("payload too large")
        return value


@router.post("/log")
async def log_client_activity(
    body: ClientActivityRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await record_activity(
        db,
        action=ActivityAction(body.action),
        actor_id=user.id,
        entity_type=body.entity_type,
        payload=body.payload,
    )
    await db.commit()
    return {"ok": True}

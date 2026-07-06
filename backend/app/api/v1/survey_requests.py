"""
Survey requests router.

  POST /api/v1/survey-requests   – log a new survey team deployment request
  GET  /api/v1/survey-requests   – list requests (newest first)
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, status as httpstatus
from geoalchemy2.shape import from_shape, to_shape
from shapely.geometry import Point
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_any
from app.db.session import get_db
from app.models import (
    ActivityAction,
    ActivityLog,
    SurveyRequest,
    SurveyRequestStatus,
    User,
)
from app.schemas.workflow import SurveyRequestCreate, SurveyRequestOut

log = logging.getLogger("davangere.api.survey_requests")
router = APIRouter()


def _to_out(row: SurveyRequest) -> SurveyRequestOut:
    pt: Point = to_shape(row.location)
    return SurveyRequestOut(
        id=row.id,
        title=row.title,
        reason=row.reason,
        ward=row.ward,
        priority=row.priority,
        status=row.status.value,
        latitude=pt.y,
        longitude=pt.x,
        requested_by=row.requested_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.post(
    "",
    response_model=SurveyRequestOut,
    status_code=httpstatus.HTTP_201_CREATED,
)
async def create_survey_request(
    body: SurveyRequestCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SurveyRequestOut:
    row = SurveyRequest(
        id=uuid.uuid4(),
        title=body.title,
        reason=body.reason,
        ward=body.ward,
        priority=body.priority,
        location=from_shape(Point(body.longitude, body.latitude), srid=4326),
        status=SurveyRequestStatus.REQUESTED,
        requested_by=current_user.id,
    )
    db.add(row)
    await db.flush()

    db.add(
        ActivityLog(
            actor_id=current_user.id,
            action=ActivityAction.SURVEY_REQUESTED,
            entity_type="survey_request",
            entity_id=row.id,
            payload={
                "ward": body.ward,
                "priority": body.priority,
                "location": {"lat": body.latitude, "lon": body.longitude},
                "action_string": "survey:requested",
            },
        )
    )
    return _to_out(row)


@router.get(
    "",
    response_model=list[SurveyRequestOut],
    dependencies=[Depends(require_any)],
)
async def list_survey_requests(
    db: AsyncSession = Depends(get_db),
    limit: int = 50,
    offset: int = 0,
) -> list[SurveyRequestOut]:
    limit = max(1, min(200, limit))
    offset = max(0, offset)
    rows = (
        await db.execute(
            select(SurveyRequest).order_by(SurveyRequest.created_at.desc()).limit(limit).offset(offset)
        )
    ).scalars().all()
    return [_to_out(r) for r in rows]

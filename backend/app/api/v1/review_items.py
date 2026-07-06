"""
Review-items router — architect workflow.

Endpoints (all mounted under /api/v1/review-items):
  GET    /{feature_id}       – list every review item on a feature
  POST   /feature/{fid}      – create a new review item on a feature
  PATCH  /{id}/status        – transition status (open → reviewing → resolved)
  POST   /{id}/comments      – add a threaded comment (parses @mentions)
  GET    /{id}/comments      – list comments in creation order

Every state mutation writes an `activity_log` row.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status as httpstatus
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_any
from app.db.session import get_db
from app.models import (
    ActivityAction,
    ActivityLog,
    Comment,
    ReviewItem,
    ReviewStatus,
    User,
)
from app.schemas.workflow import (
    CommentCreate,
    CommentOut,
    CommentWithMentions,
    ReviewItemCreate,
    ReviewItemOut,
    ReviewStatusUpdate,
)
from app.services.mentions import notify_mentions

log = logging.getLogger("davangere.api.reviews")
router = APIRouter()


async def _load_review(db: AsyncSession, review_id: uuid.UUID) -> ReviewItem:
    row = (await db.execute(select(ReviewItem).where(ReviewItem.id == review_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Review item not found")
    return row


def _comment_to_out(row: Comment) -> CommentOut:
    author_name = row.author.name if row.author else None
    return CommentOut(
        id=row.id,
        feature_id=row.feature_id,
        review_item_id=row.review_item_id,
        parent_id=row.parent_id,
        author_id=row.author_id,
        author_name=author_name,
        body=row.body,
        created_at=row.created_at,
    )


# ---------------------------------------------------------------- LIST BY FEATURE
@router.get(
    "/{feature_id}",
    response_model=list[ReviewItemOut],
    dependencies=[Depends(require_any)],
    summary="List all review items on a feature",
)
async def list_reviews_for_feature(
    feature_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[ReviewItemOut]:
    rows = (
        await db.execute(
            select(ReviewItem)
            .where(ReviewItem.feature_id == feature_id)
            .order_by(ReviewItem.created_at.desc())
        )
    ).scalars().all()
    return [ReviewItemOut.model_validate(r) for r in rows]


# ------------------------------------------------------------------------ CREATE
@router.post(
    "/feature/{feature_id}",
    response_model=ReviewItemOut,
    status_code=httpstatus.HTTP_201_CREATED,
)
async def create_review_for_feature(
    feature_id: uuid.UUID,
    body: ReviewItemCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReviewItemOut:
    row = ReviewItem(
        feature_id=feature_id,
        title=body.title,
        description=body.description,
        priority=body.priority,
        assigned_to=body.assigned_to,
        created_by=current_user.id,
        status=ReviewStatus.OPEN,
    )
    db.add(row)
    await db.flush()

    db.add(
        ActivityLog(
            actor_id=current_user.id,
            action=ActivityAction.REVIEW_ASSIGNED,
            entity_type="review_item",
            entity_id=row.id,
            payload={
                "feature_id": str(feature_id),
                "assigned_to": str(row.assigned_to) if row.assigned_to else None,
                "priority": row.priority,
            },
        )
    )
    return ReviewItemOut.model_validate(row)


# ------------------------------------------------------------------------ STATUS
@router.patch(
    "/{review_id}/status",
    response_model=ReviewItemOut,
    summary="Transition a review item's lifecycle status",
)
async def update_review_status(
    review_id: uuid.UUID,
    body: ReviewStatusUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReviewItemOut:
    row = await _load_review(db, review_id)
    if row.status == body.status:
        return ReviewItemOut.model_validate(row)

    previous = row.status
    now = datetime.now(timezone.utc)
    row.status = body.status

    # SLA deltas — only stamped once per lifecycle.
    if row.first_response_at is None and body.status in (
        ReviewStatus.REVIEWING,
        ReviewStatus.IN_PROGRESS,
        ReviewStatus.RESOLVED,
        ReviewStatus.REJECTED,
    ):
        row.first_response_at = now
    if body.status == ReviewStatus.RESOLVED and row.resolved_at is None:
        row.resolved_at = now

    db.add(
        ActivityLog(
            actor_id=current_user.id,
            action=ActivityAction.REVIEW_STATUS_CHANGED,
            entity_type="review_item",
            entity_id=row.id,
            payload={
                "feature_id": str(row.feature_id),
                "from": previous.value,
                "to": body.status.value,
                "action_string": f"status:{previous.value}→{body.status.value}",
            },
        )
    )
    return ReviewItemOut.model_validate(row)


# ---------------------------------------------------------------------- COMMENTS
@router.get(
    "/{review_id}/comments",
    response_model=list[CommentOut],
    dependencies=[Depends(require_any)],
)
async def list_comments(
    review_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[CommentOut]:
    review = await _load_review(db, review_id)
    rows = (
        await db.execute(
            select(Comment)
            .where(Comment.review_item_id == review.id)
            .order_by(Comment.created_at.asc())
        )
    ).scalars().all()
    return [_comment_to_out(r) for r in rows]


@router.post(
    "/{review_id}/comments",
    response_model=CommentWithMentions,
    status_code=httpstatus.HTTP_201_CREATED,
)
async def post_comment(
    review_id: uuid.UUID,
    body: CommentCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CommentWithMentions:
    review = await _load_review(db, review_id)

    comment = Comment(
        feature_id=review.feature_id,
        review_item_id=review.id,
        parent_id=body.parent_id,
        author_id=current_user.id,
        body=body.body,
    )
    db.add(comment)
    await db.flush()

    # @mention → notifications
    notifications = await notify_mentions(
        db,
        body=body.body,
        actor_id=current_user.id,
        comment_id=comment.id,
        feature_id=review.feature_id,
    )
    notified_ids = [n.user_id for n in notifications]

    db.add(
        ActivityLog(
            actor_id=current_user.id,
            action=ActivityAction.COMMENT_POSTED,
            entity_type="comment",
            entity_id=comment.id,
            payload={
                "feature_id": str(review.feature_id),
                "review_item_id": str(review.id),
                "mentions": [str(uid) for uid in notified_ids],
                "action_string": "comment:added",
            },
        )
    )
    # Reload with author eagerly for the response projection.
    reloaded = (
        await db.execute(select(Comment).where(Comment.id == comment.id))
    ).scalar_one()
    return CommentWithMentions(
        comment=_comment_to_out(reloaded),
        notified_user_ids=notified_ids,
    )

"""
Analytics overview endpoint — powers the left dashboard panel.

  GET /api/v1/analytics/overview
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db
from app.models import (
    Dataset,
    DatasetStatus,
    Feature,
    ReviewItem,
    ReviewStatus,
)
from app.schemas.workflow import (
    AnalyticsOverview,
    CategoryBreakdown,
    SeverityBucket,
    StatusBreakdown,
    WardBreakdown,
)

router = APIRouter()


@router.get(
    "/overview",
    response_model=AnalyticsOverview,
    dependencies=[Depends(require_any)],
)
async def analytics_overview(db: AsyncSession = Depends(get_db)) -> AnalyticsOverview:
    # ---- Dataset counts ------------------------------------------------
    ds_rows = (
        await db.execute(
            select(Dataset.status, func.count(Dataset.id)).group_by(Dataset.status)
        )
    ).all()
    total_datasets = sum(count for _, count in ds_rows)
    by_status: dict[DatasetStatus, int] = {s: c for s, c in ds_rows}

    # ---- Feature count -------------------------------------------------
    total_features = (await db.execute(select(func.count(Feature.id)))).scalar_one() or 0

    # ---- Review item counts (aggregate + breakdown) --------------------
    review_rows = (
        await db.execute(
            select(ReviewItem.status, func.count(ReviewItem.id)).group_by(ReviewItem.status)
        )
    ).all()
    total_reviews = sum(count for _, count in review_rows)
    status_breakdown = [StatusBreakdown(status=s, count=c) for s, c in review_rows]
    open_reviews = sum(
        c for s, c in review_rows if s in (ReviewStatus.OPEN, ReviewStatus.REVIEWING, ReviewStatus.IN_PROGRESS)
    )
    resolved_reviews = sum(c for s, c in review_rows if s == ReviewStatus.RESOLVED)

    # ---- Ward breakdown (features + open/resolved counts per ward) -----
    ward_rows = (
        await db.execute(
            select(
                Dataset.ward.label("ward"),
                func.count(Feature.id).label("feature_count"),
                func.count(ReviewItem.id).filter(
                    ReviewItem.status.in_(
                        [ReviewStatus.OPEN, ReviewStatus.REVIEWING, ReviewStatus.IN_PROGRESS]
                    )
                ).label("open_reviews"),
                func.count(ReviewItem.id).filter(
                    ReviewItem.status == ReviewStatus.RESOLVED
                ).label("resolved_reviews"),
            )
            .join(Feature, Feature.dataset_id == Dataset.id)
            .outerjoin(ReviewItem, ReviewItem.feature_id == Feature.id)
            .where(Dataset.ward.isnot(None))
            .group_by(Dataset.ward)
            .order_by(func.count(Feature.id).desc())
            .limit(30)
        )
    ).all()

    ward_breakdown = [
        WardBreakdown(
            ward=r.ward or "unassigned",
            feature_count=int(r.feature_count or 0),
            open_reviews=int(r.open_reviews or 0),
            resolved_reviews=int(r.resolved_reviews or 0),
        )
        for r in ward_rows
    ]

    # ---- Category breakdown (what kind of asset each point represents) --
    category_expr = func.coalesce(Feature.category, "uncategorized")
    category_rows = (
        await db.execute(
            select(
                category_expr.label("category"),
                func.count(Feature.id).label("count"),
                func.avg(Feature.severity).label("avg_severity"),
            )
            .group_by(category_expr)
            .order_by(func.count(Feature.id).desc())
            .limit(20)
        )
    ).all()
    category_breakdown = [
        CategoryBreakdown(
            category=r.category,
            count=int(r.count),
            avg_severity=round(float(r.avg_severity or 0.0), 3),
        )
        for r in category_rows
    ]

    # ---- Severity distribution (low <0.34, medium <0.67, high >=0.67) ---
    severity_case = case(
        (Feature.severity < 0.34, "low"),
        (Feature.severity < 0.67, "medium"),
        else_="high",
    )
    severity_rows = (
        await db.execute(
            select(severity_case.label("bucket"), func.count(Feature.id).label("count")).group_by(
                severity_case
            )
        )
    ).all()
    severity_by_bucket = {r.bucket: int(r.count) for r in severity_rows}
    severity_breakdown = [
        SeverityBucket(bucket=b, count=severity_by_bucket.get(b, 0)) for b in ("low", "medium", "high")
    ]

    return AnalyticsOverview(
        total_datasets=int(total_datasets),
        ready_datasets=int(by_status.get(DatasetStatus.READY, 0)),
        processing_datasets=int(
            by_status.get(DatasetStatus.PROCESSING, 0) + by_status.get(DatasetStatus.QUEUED, 0)
        ),
        failed_datasets=int(by_status.get(DatasetStatus.FAILED, 0)),
        total_features=int(total_features),
        total_review_items=int(total_reviews),
        open_reviews=int(open_reviews),
        resolved_reviews=int(resolved_reviews),
        status_breakdown=status_breakdown,
        ward_breakdown=ward_breakdown,
        category_breakdown=category_breakdown,
        severity_breakdown=severity_breakdown,
        generated_at=datetime.now(timezone.utc),
    )

"""
Analytics overview endpoint — powers the left dashboard panel.

  GET /api/v1/analytics/overview
"""
from __future__ import annotations

from datetime import datetime, timezone

import uuid

from fastapi import APIRouter, Depends, Query
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
    IngestionTrendPoint,
    SeverityBucket,
    StatusBreakdown,
    WardBreakdown,
)

router = APIRouter()

# raster_pixel rows are the RasterReader's internal sample grid (kept for
# the feature table / severity / AI-summary pipeline) — not real surveyed
# assets. The map already hides them from its feature layers/legend/top
# severity list; every analytics query below excludes them too so "Features
# Mapped", category/severity breakdowns, and the trend line all describe
# actual surveyed infrastructure, not raster-sampling implementation detail.
_NOT_RASTER_SAMPLE = Feature.category.is_distinct_from("raster_pixel")


@router.get(
    "/overview",
    response_model=AnalyticsOverview,
    dependencies=[Depends(require_any)],
)
async def analytics_overview(
    dataset_id: list[uuid.UUID] | None = Query(
        default=None,
        description="Scope every figure to one or more datasets (mirrors the map's dataset selection).",
    ),
    db: AsyncSession = Depends(get_db),
) -> AnalyticsOverview:
    scoped = bool(dataset_id)

    # ---- Dataset counts ------------------------------------------------
    ds_stmt = select(Dataset.status, func.count(Dataset.id))
    if scoped:
        ds_stmt = ds_stmt.where(Dataset.id.in_(dataset_id))
    ds_rows = (await db.execute(ds_stmt.group_by(Dataset.status))).all()
    total_datasets = sum(count for _, count in ds_rows)
    by_status: dict[DatasetStatus, int] = {s: c for s, c in ds_rows}

    # ---- Feature count -------------------------------------------------
    feature_stmt = select(func.count(Feature.id)).where(_NOT_RASTER_SAMPLE)
    if scoped:
        feature_stmt = feature_stmt.where(Feature.dataset_id.in_(dataset_id))
    total_features = (await db.execute(feature_stmt)).scalar_one() or 0

    # ---- Review item counts (aggregate + breakdown) --------------------
    review_stmt = select(ReviewItem.status, func.count(ReviewItem.id))
    if scoped:
        review_stmt = review_stmt.join(Feature, Feature.id == ReviewItem.feature_id).where(
            Feature.dataset_id.in_(dataset_id)
        )
    review_rows = (await db.execute(review_stmt.group_by(ReviewItem.status))).all()
    total_reviews = sum(count for _, count in review_rows)
    status_breakdown = [StatusBreakdown(status=s, count=c) for s, c in review_rows]
    open_reviews = sum(
        c for s, c in review_rows if s in (ReviewStatus.OPEN, ReviewStatus.REVIEWING, ReviewStatus.IN_PROGRESS)
    )
    resolved_reviews = sum(c for s, c in review_rows if s == ReviewStatus.RESOLVED)

    # ---- Ward breakdown (features + open/resolved counts per ward) -----
    ward_conditions = [Dataset.ward.isnot(None), _NOT_RASTER_SAMPLE]
    if scoped:
        ward_conditions.append(Dataset.id.in_(dataset_id))
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
            .where(*ward_conditions)
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
    category_stmt = select(
        category_expr.label("category"),
        func.count(Feature.id).label("count"),
        func.avg(Feature.severity).label("avg_severity"),
    ).where(_NOT_RASTER_SAMPLE)
    if scoped:
        category_stmt = category_stmt.where(Feature.dataset_id.in_(dataset_id))
    category_rows = (
        await db.execute(category_stmt.group_by(category_expr).order_by(func.count(Feature.id).desc()).limit(20))
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
    severity_stmt = select(severity_case.label("bucket"), func.count(Feature.id).label("count")).where(
        _NOT_RASTER_SAMPLE
    )
    if scoped:
        severity_stmt = severity_stmt.where(Feature.dataset_id.in_(dataset_id))
    severity_rows = (await db.execute(severity_stmt.group_by(severity_case))).all()
    severity_by_bucket = {r.bucket: int(r.count) for r in severity_rows}
    severity_breakdown = [
        SeverityBucket(bucket=b, count=severity_by_bucket.get(b, 0)) for b in ("low", "medium", "high")
    ]

    # ---- Ingestion trend (real growth over time, from each feature's ----
    # ---- actual created_at — NOT simulated/interpolated data) -----------
    day_expr = func.date(Feature.created_at)
    trend_stmt = select(day_expr.label("day"), func.count(Feature.id).label("c")).where(_NOT_RASTER_SAMPLE)
    if scoped:
        trend_stmt = trend_stmt.where(Feature.dataset_id.in_(dataset_id))
    trend_rows = (await db.execute(trend_stmt.group_by(day_expr).order_by(day_expr))).all()
    cumulative = 0
    ingestion_trend: list[IngestionTrendPoint] = []
    for r in trend_rows:
        cumulative += int(r.c)
        ingestion_trend.append(
            IngestionTrendPoint(
                date=r.day.isoformat() if hasattr(r.day, "isoformat") else str(r.day),
                features_added=int(r.c),
                cumulative_features=cumulative,
            )
        )

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
        ingestion_trend=ingestion_trend,
        generated_at=datetime.now(timezone.utc),
    )

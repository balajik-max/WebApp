"""
Analytics endpoints.

  GET /api/v1/analytics/overview
  GET /api/v1/analytics/features
  GET /api/v1/analytics/quality

Every result is calculated from the same optional dataset/category scope.
The category parameters are repeatable, so callers can select zero, one,
or any number of categories without changing the endpoint shape.
"""
from __future__ import annotations

from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db
from app.models import Dataset, DatasetStatus, Feature, ReviewItem, ReviewStatus
from app.schemas.workflow import (
    AnalyticsFeaturePage,
    AnalyticsFeatureRow,
    AnalyticsOverview,
    AnalyticsQualityReport,
    CategoryBreakdown,
    IngestionTrendPoint,
    SeverityBucket,
    StatusBreakdown,
    WardBreakdown,
)

from app.services.analytics.quality import build_quality_report
from app.services.analytics.scope import (
    CATEGORY_EXPR,
    clean_categories,
    clean_severity_buckets,
    clean_wards,
    feature_conditions,
)

router = APIRouter()


@router.get(
    "/overview",
    response_model=AnalyticsOverview,
    dependencies=[Depends(require_any)],
)
async def analytics_overview(
    dataset_id: list[uuid.UUID] | None = Query(
        default=None,
        description="Restrict every figure to one or more datasets. Repeat for multiple values.",
    ),
    category: list[str] | None = Query(
        default=None,
        description="Restrict every figure to one or more categories. Repeat for multiple values.",
    ),
    ward: list[str] | None = Query(
        default=None,
        description="Optional cross-filter by one or more dataset wards.",
    ),
    severity_bucket: list[str] | None = Query(
        default=None,
        description="Optional cross-filter. Repeat low, medium, or high values.",
    ),
    db: AsyncSession = Depends(get_db),
) -> AnalyticsOverview:
    dataset_ids = list(dict.fromkeys(dataset_id or []))
    categories = clean_categories(category)
    wards = clean_wards(ward)
    severity_buckets = clean_severity_buckets(severity_bucket)
    scoped_feature_conditions = feature_conditions(
        dataset_ids, categories, wards, severity_buckets
    )

    # Dataset status counts. With a category filter, only datasets that really
    # contain a matching feature contribute to the scoped survey count.
    if categories or severity_buckets:
        ds_stmt = (
            select(Dataset.status, func.count(func.distinct(Dataset.id)))
            .join(Feature, Feature.dataset_id == Dataset.id)
            .where(*scoped_feature_conditions)
            .group_by(Dataset.status)
        )
    else:
        ds_stmt = select(Dataset.status, func.count(Dataset.id))
        if dataset_ids:
            ds_stmt = ds_stmt.where(Dataset.id.in_(dataset_ids))
        if wards:
            ds_stmt = ds_stmt.where(Dataset.ward.in_(wards))
        ds_stmt = ds_stmt.group_by(Dataset.status)

    ds_rows = (await db.execute(ds_stmt)).all()
    total_datasets = sum(int(count) for _, count in ds_rows)
    by_status: dict[DatasetStatus, int] = {status: int(count) for status, count in ds_rows}

    # Feature total and average severity come from the full matching scope,
    # not from the top-category chart subset.
    feature_stats = (
        await db.execute(
            select(
                func.count(Feature.id).label("total"),
                func.avg(Feature.severity).label("average_severity"),
            ).where(*scoped_feature_conditions)
        )
    ).one()
    total_features = int(feature_stats.total or 0)
    average_severity = round(float(feature_stats.average_severity or 0.0), 3)

    # Review counts always join back to the exact feature scope.
    review_rows = (
        await db.execute(
            select(ReviewItem.status, func.count(ReviewItem.id))
            .join(Feature, Feature.id == ReviewItem.feature_id)
            .where(*scoped_feature_conditions)
            .group_by(ReviewItem.status)
        )
    ).all()
    total_reviews = sum(int(count) for _, count in review_rows)
    status_breakdown = [StatusBreakdown(status=status, count=int(count)) for status, count in review_rows]
    open_reviews = sum(
        int(count)
        for status, count in review_rows
        if status in (ReviewStatus.OPEN, ReviewStatus.REVIEWING, ReviewStatus.IN_PROGRESS)
    )
    resolved_reviews = sum(
        int(count) for status, count in review_rows if status == ReviewStatus.RESOLVED
    )

    # Ward feature totals and review totals are aggregated separately. This
    # prevents a feature with multiple review items from being counted more
    # than once in the feature_count column.
    ward_feature_rows = (
        await db.execute(
            select(
                Dataset.ward.label("ward"),
                func.count(Feature.id).label("feature_count"),
            )
            .join(Feature, Feature.dataset_id == Dataset.id)
            .where(Dataset.ward.isnot(None), *scoped_feature_conditions)
            .group_by(Dataset.ward)
        )
    ).all()

    ward_review_rows = (
        await db.execute(
            select(
                Dataset.ward.label("ward"),
                func.count(ReviewItem.id)
                .filter(
                    ReviewItem.status.in_(
                        [ReviewStatus.OPEN, ReviewStatus.REVIEWING, ReviewStatus.IN_PROGRESS]
                    )
                )
                .label("open_reviews"),
                func.count(ReviewItem.id)
                .filter(ReviewItem.status == ReviewStatus.RESOLVED)
                .label("resolved_reviews"),
            )
            .join(Feature, Feature.dataset_id == Dataset.id)
            .join(ReviewItem, ReviewItem.feature_id == Feature.id)
            .where(Dataset.ward.isnot(None), *scoped_feature_conditions)
            .group_by(Dataset.ward)
        )
    ).all()

    review_by_ward = {
        row.ward: (int(row.open_reviews or 0), int(row.resolved_reviews or 0))
        for row in ward_review_rows
    }
    ward_breakdown = [
        WardBreakdown(
            ward=row.ward or "unassigned",
            feature_count=int(row.feature_count or 0),
            open_reviews=review_by_ward.get(row.ward, (0, 0))[0],
            resolved_reviews=review_by_ward.get(row.ward, (0, 0))[1],
        )
        for row in sorted(ward_feature_rows, key=lambda item: int(item.feature_count or 0), reverse=True)
    ]

    # No top-20 cap: the selector and detail table receive every real
    # category in the matching dataset scope.
    category_rows = (
        await db.execute(
            select(
                CATEGORY_EXPR.label("category"),
                func.count(Feature.id).label("count"),
                func.avg(Feature.severity).label("avg_severity"),
            )
            .where(*scoped_feature_conditions)
            .group_by(CATEGORY_EXPR)
            .order_by(func.count(Feature.id).desc(), CATEGORY_EXPR.asc())
        )
    ).all()
    category_breakdown = [
        CategoryBreakdown(
            category=row.category,
            count=int(row.count or 0),
            avg_severity=round(float(row.avg_severity or 0.0), 3),
        )
        for row in category_rows
    ]

    severity_case = case(
        (Feature.severity < 0.34, "low"),
        (Feature.severity < 0.67, "medium"),
        else_="high",
    )
    severity_rows = (
        await db.execute(
            select(severity_case.label("bucket"), func.count(Feature.id).label("count"))
            .where(*scoped_feature_conditions)
            .group_by(severity_case)
        )
    ).all()
    severity_by_bucket = {row.bucket: int(row.count or 0) for row in severity_rows}
    severity_breakdown = [
        SeverityBucket(bucket=bucket, count=severity_by_bucket.get(bucket, 0))
        for bucket in ("low", "medium", "high")
    ]

    day_expr = func.date(Feature.created_at)
    trend_rows = (
        await db.execute(
            select(day_expr.label("day"), func.count(Feature.id).label("count"))
            .where(*scoped_feature_conditions)
            .group_by(day_expr)
            .order_by(day_expr)
        )
    ).all()
    cumulative = 0
    ingestion_trend: list[IngestionTrendPoint] = []
    for row in trend_rows:
        added = int(row.count or 0)
        cumulative += added
        ingestion_trend.append(
            IngestionTrendPoint(
                date=row.day.isoformat() if hasattr(row.day, "isoformat") else str(row.day),
                features_added=added,
                cumulative_features=cumulative,
            )
        )

    return AnalyticsOverview(
        total_datasets=total_datasets,
        ready_datasets=int(by_status.get(DatasetStatus.READY, 0)),
        processing_datasets=int(
            by_status.get(DatasetStatus.PROCESSING, 0)
            + by_status.get(DatasetStatus.QUEUED, 0)
        ),
        failed_datasets=int(by_status.get(DatasetStatus.FAILED, 0)),
        total_features=total_features,
        average_severity=average_severity,
        total_review_items=total_reviews,
        open_reviews=open_reviews,
        resolved_reviews=resolved_reviews,
        status_breakdown=status_breakdown,
        ward_breakdown=ward_breakdown,
        category_breakdown=category_breakdown,
        severity_breakdown=severity_breakdown,
        ingestion_trend=ingestion_trend,
        generated_at=datetime.now(timezone.utc),
    )


@router.get(
    "/features",
    response_model=AnalyticsFeaturePage,
    dependencies=[Depends(require_any)],
    summary="Paginated feature rows for the currently applied Analytics scope",
)
async def analytics_features(
    dataset_id: list[uuid.UUID] | None = Query(default=None),
    category: list[str] | None = Query(default=None),
    ward: list[str] | None = Query(default=None),
    severity_bucket: list[str] | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> AnalyticsFeaturePage:
    dataset_ids = list(dict.fromkeys(dataset_id or []))
    categories = clean_categories(category)
    wards = clean_wards(ward)
    severity_buckets = clean_severity_buckets(severity_bucket)
    conditions = feature_conditions(dataset_ids, categories, wards, severity_buckets)

    total = int(
        (
            await db.execute(select(func.count(Feature.id)).where(*conditions))
        ).scalar_one()
        or 0
    )

    rows = (
        await db.execute(
            select(
                Feature.id,
                Feature.dataset_id,
                Dataset.name.label("dataset_name"),
                Dataset.ward,
                Feature.label,
                CATEGORY_EXPR.label("category"),
                Feature.severity,
                func.GeometryType(Feature.geom).label("geometry_type"),
                Feature.created_at,
            )
            .join(Dataset, Dataset.id == Feature.dataset_id)
            .where(*conditions)
            .order_by(Feature.severity.desc(), Feature.created_at, Feature.id)
            .limit(limit)
            .offset(offset)
        )
    ).all()

    return AnalyticsFeaturePage(
        total=total,
        limit=limit,
        offset=offset,
        rows=[
            AnalyticsFeatureRow(
                id=row.id,
                dataset_id=row.dataset_id,
                dataset_name=row.dataset_name,
                ward=row.ward,
                label=row.label,
                category=row.category,
                severity=float(row.severity or 0.0),
                geometry_type=str(row.geometry_type or "Unknown"),
                created_at=row.created_at,
            )
            for row in rows
        ],
    )


@router.get(
    "/quality",
    response_model=AnalyticsQualityReport,
    dependencies=[Depends(require_any)],
    summary="Deterministic data-quality score, verified findings, and priority ranking",
)
async def analytics_quality(
    dataset_id: list[uuid.UUID] | None = Query(default=None),
    category: list[str] | None = Query(default=None),
    ward: list[str] | None = Query(default=None),
    severity_bucket: list[str] | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> AnalyticsQualityReport:
    dataset_ids = list(dict.fromkeys(dataset_id or []))
    categories = clean_categories(category)
    wards = clean_wards(ward)
    severity_buckets = clean_severity_buckets(severity_bucket)
    return await build_quality_report(
        db,
        dataset_ids=dataset_ids,
        categories=categories,
        wards=wards,
        severity_buckets=severity_buckets,
    )

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
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import case, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db
from app.models import Dataset, DatasetStatus, Feature, ReviewItem, ReviewStatus
from app.schemas.workflow import (
    AnalyticsFeaturePage,
    AnalyticsFeatureRow,
    AnalyticsOverview,
    AnalyticsQualityReport,
    DrainEncroachmentBuildingOut,
    DrainEncroachmentDrainOut,
    DrainEncroachmentReport,
    ManholeReadinessFieldResult,
    ManholeReadinessReport,
    CategoryBreakdown,
    IngestionTrendPoint,
    SeverityBucket,
    StatusBreakdown,
    WardBreakdown,
    WardCensusInfo,
    WardWaterDemandReport,
    WaterDemandLineItemOut,
)

from app.services.analytics.exports import AnalyticsExportFormat, build_analytics_export
from app.services.analytics.quality import build_quality_report
from app.services.analytics.readiness import (
    attribute_readiness_status,
    attribute_value,
    clean_missing_field,
    clean_readiness_field,
    clean_readiness_status,
    field_available_condition,
    get_readiness_field,
    manhole_category_condition,
    readiness_fields,
    resolve_readiness_filter,
)
from app.services.analytics.scope import (
    CATEGORY_EXPR,
    clean_categories,
    clean_severity_buckets,
    clean_wards,
    feature_conditions,
)
from app.services.analytics.ward_water_demand import build_ward_water_demand

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
    readiness_field: str | None = Query(
        default=None,
        description="Optional Manhole readiness field, such as depth or bottom_level.",
    ),
    readiness_status: str | None = Query(
        default=None,
        description="Optional readiness state: all, available, or missing.",
    ),
    missing_field: str | None = Query(
        default=None,
        description="Deprecated missing-only Manhole readiness field.",
    ),
    db: AsyncSession = Depends(get_db),
) -> AnalyticsOverview:
    dataset_ids = list(dict.fromkeys(dataset_id or []))
    categories = clean_categories(category)
    wards = clean_wards(ward)
    severity_buckets = clean_severity_buckets(severity_bucket)
    resolved_readiness_field, resolved_readiness_status = resolve_readiness_filter(
        readiness_field=readiness_field,
        readiness_status=readiness_status,
        missing_field=missing_field,
    )
    scoped_feature_conditions = feature_conditions(
        dataset_ids,
        categories,
        wards,
        severity_buckets,
        readiness_field=resolved_readiness_field,
        readiness_status=resolved_readiness_status,
    )

    # Dataset status counts. With a category filter, only datasets that really
    # contain a matching feature contribute to the scoped survey count.
    if categories or severity_buckets or resolved_readiness_field:
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
    "/manhole-readiness",
    response_model=ManholeReadinessReport,
    dependencies=[Depends(require_any)],
    summary="Available-versus-missing counts for verified Manhole fields",
)
async def manhole_readiness(
    dataset_id: list[uuid.UUID] | None = Query(default=None),
    ward: list[str] | None = Query(default=None),
    severity_bucket: list[str] | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> ManholeReadinessReport:
    dataset_ids = list(dict.fromkeys(dataset_id or []))
    wards = clean_wards(ward)
    severity_buckets = clean_severity_buckets(severity_bucket)
    conditions = feature_conditions(dataset_ids, [], wards, severity_buckets)
    conditions.append(manhole_category_condition())

    field_specs = list(readiness_fields())
    columns = [func.count(Feature.id).label("total")]
    columns.extend(
        func.count(Feature.id)
        .filter(field_available_condition(field.key))
        .label(f"available_{field.key}")
        for field in field_specs
    )
    row = (await db.execute(select(*columns).where(*conditions))).one()
    total = int(row.total or 0)

    fields = []
    for field in field_specs:
        available = int(getattr(row, f"available_{field.key}") or 0)
        missing = max(0, total - available)
        completeness = round((available / total) * 100.0, 1) if total else 0.0
        fields.append(
            ManholeReadinessFieldResult(
                key=field.key,
                label=field.label,
                aliases=list(field.aliases),
                available_count=available,
                missing_count=missing,
                completeness_percentage=completeness,
                recommended_action=field.recommended_action,
            )
        )

    return ManholeReadinessReport(
        total_manhole_features=total,
        fields=fields,
        methodology=(
            "Counts are read directly from existing Manhole attributes. A value is missing "
            "when every configured alias is blank, null, unknown, or another standard empty marker. "
            "No source feature or GDB attribute is modified."
        ),
        generated_at=datetime.now(timezone.utc),
    )


@router.get(
    "/manhole-readiness/features",
    dependencies=[Depends(require_any)],
    summary="GeoJSON evidence for one Manhole readiness field",
)
async def manhole_readiness_features(
    field: str = Query(..., description="Readiness field key, such as depth or condition."),
    status: str = Query(default="missing", description="all, available, or missing"),
    dataset_id: list[uuid.UUID] | None = Query(default=None),
    ward: list[str] | None = Query(default=None),
    severity_bucket: list[str] | None = Query(default=None),
    limit: int = Query(default=5000, ge=1, le=5000),
    db: AsyncSession = Depends(get_db),
) -> dict:
    field_key = clean_readiness_field(field)
    assert field_key is not None
    readiness_status = clean_readiness_status(status)
    field_spec = get_readiness_field(field_key)
    dataset_ids = list(dict.fromkeys(dataset_id or []))
    wards = clean_wards(ward)
    severity_buckets = clean_severity_buckets(severity_bucket)
    conditions = feature_conditions(
        dataset_ids,
        [],
        wards,
        severity_buckets,
        readiness_field=field_key,
        readiness_status=readiness_status,
    )

    total = int(
        (await db.execute(select(func.count(Feature.id)).where(*conditions))).scalar_one()
        or 0
    )
    rows = (
        await db.execute(
            select(
                Feature.id,
                Feature.dataset_id,
                Feature.label,
                CATEGORY_EXPR.label("category"),
                Feature.severity,
                Feature.attributes,
                func.ST_AsGeoJSON(Feature.geom, 6).label("geometry_json"),
            )
            .where(*conditions)
            .order_by(Feature.severity.desc(), Feature.id)
            .limit(limit)
        )
    ).all()

    features = []
    for row in rows:
        geometry = json.loads(row.geometry_json) if row.geometry_json else None
        attributes = row.attributes if isinstance(row.attributes, dict) else {}
        row_status = attribute_readiness_status(attributes, field_key)
        row_value = attribute_value(attributes, field_key)
        features.append(
            {
                "type": "Feature",
                "id": str(row.id),
                "geometry": geometry,
                "properties": {
                    "id": str(row.id),
                    "dataset_id": str(row.dataset_id),
                    "label": row.label,
                    "category": row.category,
                    "severity": float(row.severity or 0.0),
                    "attributes": attributes,
                    "readiness_field": field_key,
                    "readiness_field_label": field_spec.label,
                    "readiness_status": row_status,
                    "readiness_value": None if row_value is None else str(row_value),
                    "recommended_action": (
                        field_spec.recommended_action if row_status == "missing" else None
                    ),
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "features": features,
        "bbox": [-180, -90, 180, 90],
        "count": len(features),
        "limit": limit,
        "truncated": total > limit,
    }


@router.get(
    "/drain-encroachment",
    response_model=DrainEncroachmentReport,
    dependencies=[Depends(require_any)],
    summary="Exact surveyed drain/building intersections",
)
async def drain_encroachment_report(
    dataset_id: list[uuid.UUID] = Query(..., description="One or more active survey datasets."),
    db: AsyncSession = Depends(get_db),
) -> DrainEncroachmentReport:
    dataset_ids = list(dict.fromkeys(dataset_id))
    if not dataset_ids:
        raise HTTPException(status_code=400, detail="At least one dataset_id is required")

    params = {"dataset_ids": dataset_ids}
    common_cte = (
        "WITH drains AS ("
        "  SELECT id, dataset_id, attributes, ST_MakeValid(geom) AS geom "
        "  FROM features "
        "  WHERE dataset_id = ANY(:dataset_ids) "
        "    AND attributes->>'_canonical_class' = 'Drainage_Asset'"
        "), buildings AS ("
        "  SELECT id, dataset_id, ST_MakeValid(geom) AS geom "
        "  FROM features "
        "  WHERE dataset_id = ANY(:dataset_ids) "
        "    AND attributes->>'_canonical_class' = 'Building'"
        "), pairs AS ("
        "  SELECT d.id AS drain_id, b.id AS building_id, b.geom AS building_geom, "
        "         ST_CollectionExtract(ST_Intersection(d.geom, b.geom), 2) AS crossing_geom, "
        "         ST_Length(ST_Intersection(d.geom, b.geom)::geography) AS crossing_length_m, "
        "         ST_Perimeter(b.geom::geography) / 4.0 AS building_span_m "
        "  FROM drains d JOIN buildings b ON b.dataset_id = d.dataset_id "
        "    AND ST_Intersects(d.geom, b.geom) "
        "  WHERE ST_Length(ST_Intersection(d.geom, b.geom)::geography) > 0.01"
        ") "
    )

    building_rows = (
        await db.execute(
            text(
                common_cte
                + "SELECT building_id, array_agg(DISTINCT drain_id) AS drain_ids, "
                "       SUM(crossing_length_m) AS crossing_length_m, "
                "       MAX(building_span_m) AS building_span_m, "
                "       ST_AsGeoJSON(ST_Union(building_geom), 6) AS geometry_json, "
                "       ST_AsGeoJSON(ST_UnaryUnion(ST_Collect(crossing_geom)), 6) AS crossing_json "
                "FROM pairs GROUP BY building_id ORDER BY SUM(crossing_length_m) DESC"
            ),
            params,
        )
    ).mappings().all()

    drain_rows = (
        await db.execute(
            text(
                common_cte
                + "SELECT d.id AS drain_id, d.attributes->>'FID' AS fid, "
                "       COUNT(DISTINCT p.building_id) AS affected_buildings, "
                "       COALESCE(SUM(p.crossing_length_m), 0) AS crossing_length_m "
                "FROM drains d LEFT JOIN pairs p ON p.drain_id = d.id "
                "GROUP BY d.id, d.attributes "
                "ORDER BY affected_buildings DESC, crossing_length_m DESC"
            ),
            params,
        )
    ).mappings().all()

    buildings: list[DrainEncroachmentBuildingOut] = []
    major_crossings = 0
    partial_clips = 0
    crossing_length_m = 0.0
    intersection_pairs = 0
    for row in building_rows:
        length_m = float(row["crossing_length_m"] or 0.0)
        span_m = float(row["building_span_m"] or 0.0)
        crossing_ratio_pct = min(100.0, (length_m / span_m) * 100.0) if span_m > 0 else 0.0
        classification = "major_crossing" if crossing_ratio_pct > 50.0 else "partial_clip"
        if classification == "major_crossing":
            major_crossings += 1
        else:
            partial_clips += 1
        drain_ids = list(row["drain_ids"] or [])
        intersection_pairs += len(drain_ids)
        crossing_length_m += length_m
        buildings.append(
            DrainEncroachmentBuildingOut(
                building_id=row["building_id"],
                drain_ids=drain_ids,
                classification=classification,
                crossing_length_m=round(length_m, 2),
                crossing_ratio_pct=round(crossing_ratio_pct, 1),
                geometry=json.loads(row["geometry_json"]),
                crossing_geometry=json.loads(row["crossing_json"]),
            )
        )

    drains = [
        DrainEncroachmentDrainOut(
            drain_id=row["drain_id"],
            fid=row["fid"],
            affected_buildings=int(row["affected_buildings"] or 0),
            crossing_length_m=round(float(row["crossing_length_m"] or 0.0), 2),
        )
        for row in drain_rows
    ]
    affected_drains = sum(1 for row in drains if row.affected_buildings > 0)

    return DrainEncroachmentReport(
        total_drains=len(drains),
        affected_drains=affected_drains,
        clear_drains=max(0, len(drains) - affected_drains),
        affected_buildings=len(buildings),
        major_crossings=major_crossings,
        partial_clips=partial_clips,
        intersection_pairs=intersection_pairs,
        crossing_length_m=round(crossing_length_m, 2),
        buildings=buildings,
        drains=drains,
        methodology=(
            "Deterministic PostGIS analysis using zero-tolerance ST_Intersects against the raw "
            "surveyed Drainage_Asset centerlines. Exact line portions inside each Building footprint "
            "are returned from ST_Intersection; no AI inference or proximity buffer creates a finding."
        ),
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
    readiness_field: str | None = Query(default=None),
    readiness_status: str | None = Query(default=None),
    missing_field: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> AnalyticsFeaturePage:
    dataset_ids = list(dict.fromkeys(dataset_id or []))
    categories = clean_categories(category)
    wards = clean_wards(ward)
    severity_buckets = clean_severity_buckets(severity_bucket)
    resolved_field, resolved_status = resolve_readiness_filter(
        readiness_field=readiness_field,
        readiness_status=readiness_status,
        missing_field=missing_field,
    )
    conditions = feature_conditions(
        dataset_ids,
        categories,
        wards,
        severity_buckets,
        readiness_field=resolved_field,
        readiness_status=resolved_status,
    )

    total = int(
        (await db.execute(select(func.count(Feature.id)).where(*conditions))).scalar_one()
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
                Feature.attributes,
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

    field_spec = get_readiness_field(resolved_field) if resolved_field else None
    response_rows = []
    for row in rows:
        attributes = row.attributes if isinstance(row.attributes, dict) else {}
        row_status = (
            attribute_readiness_status(attributes, resolved_field)
            if resolved_field
            else None
        )
        row_value = attribute_value(attributes, resolved_field) if resolved_field else None
        response_rows.append(
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
                readiness_field_label=field_spec.label if field_spec else None,
                readiness_status=row_status,
                readiness_value=None if row_value is None else str(row_value),
            )
        )

    return AnalyticsFeaturePage(
        total=total,
        limit=limit,
        offset=offset,
        rows=response_rows,
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
    readiness_field: str | None = Query(default=None),
    readiness_status: str | None = Query(default=None),
    missing_field: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> AnalyticsQualityReport:
    dataset_ids = list(dict.fromkeys(dataset_id or []))
    categories = clean_categories(category)
    wards = clean_wards(ward)
    severity_buckets = clean_severity_buckets(severity_bucket)
    resolved_field, resolved_status = resolve_readiness_filter(
        readiness_field=readiness_field,
        readiness_status=readiness_status,
        missing_field=missing_field,
    )
    return await build_quality_report(
        db,
        dataset_ids=dataset_ids,
        categories=categories,
        wards=wards,
        severity_buckets=severity_buckets,
        readiness_field=resolved_field,
        readiness_status=resolved_status,
    )


@router.get(
    "/export",
    dependencies=[Depends(require_any)],
    summary="Download the currently applied Analytics scope",
)
async def analytics_export(
    format: AnalyticsExportFormat = Query(
        default="xlsx",
        description="Export format: csv, xlsx, pdf, or geojson.",
    ),
    dataset_id: list[uuid.UUID] | None = Query(default=None),
    category: list[str] | None = Query(default=None),
    ward: list[str] | None = Query(default=None),
    severity_bucket: list[str] | None = Query(default=None),
    readiness_field: str | None = Query(default=None),
    readiness_status: str | None = Query(default=None),
    missing_field: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> Response:
    dataset_ids = list(dict.fromkeys(dataset_id or []))
    categories = clean_categories(category)
    wards = clean_wards(ward)
    severity_buckets = clean_severity_buckets(severity_bucket)
    resolved_field, resolved_status = resolve_readiness_filter(
        readiness_field=readiness_field,
        readiness_status=readiness_status,
        missing_field=missing_field,
    )
    content, media_type, filename = await build_analytics_export(
        db,
        export_format=format,
        dataset_ids=dataset_ids,
        categories=categories,
        wards=wards,
        severity_buckets=severity_buckets,
        readiness_field=resolved_field,
        readiness_status=resolved_status,
    )
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get(
    "/water-demand",
    response_model=WardWaterDemandReport,
    dependencies=[Depends(require_any)],
    summary="Ward population (live from the Corporation's census pages) and estimated water demand",
)
async def analytics_water_demand(
    ward: list[str] = Query(
        ...,
        description="Exactly one ward is required to scope a water-demand report.",
    ),
    dataset_id: list[uuid.UUID] | None = Query(default=None),
    floating_population: int = Query(
        default=0,
        ge=0,
        description="Optional transient population (markets, bus stand, festivals) added to the census figure.",
    ),
    population_override: int | None = Query(
        default=None,
        ge=0,
        description="Manual correction: use this population instead of the resolved census figure.",
    ),
    lpcd_override: float | None = Query(
        default=None,
        gt=0,
        description="Manual correction: use this per-capita allowance (litres/person/day) instead of the resolved default.",
    ),
    db: AsyncSession = Depends(get_db),
) -> WardWaterDemandReport:
    dataset_ids = list(dict.fromkeys(dataset_id or []))
    wards = clean_wards(ward)
    if len(wards) != 1:
        raise HTTPException(
            status_code=400,
            detail="Exactly one ward value is required for a water-demand report.",
        )
    ward_label = wards[0]

    result = await build_ward_water_demand(
        db,
        ward_label=ward_label,
        dataset_ids=dataset_ids,
        floating_population=floating_population,
        population_override=population_override,
        lpcd_override=lpcd_override,
    )

    matched = result.resolution.matched
    census = WardCensusInfo(
        ward_no=matched.ward_no if matched else None,
        ward_name=matched.ward_name if matched else None,
        males=matched.males if matched else None,
        females=matched.females if matched else None,
        persons=matched.persons if matched else None,
        area_sq_km=matched.area_sq_km if matched else None,
        population_per_sq_km=(
            round(matched.persons / matched.area_sq_km, 1)
            if matched and matched.area_sq_km
            else None
        ),
        match_method=result.resolution.match_method,
        match_confidence=result.resolution.match_confidence,
        data_source=result.resolution.data_source,
        source_fetched_at=result.resolution.source_fetched_at,
    )

    breakdown = result.breakdown
    return WardWaterDemandReport(
        ward_label=result.ward_label,
        census=census,
        population_used=result.population_used,
        population_source=result.population_source,  # type: ignore[arg-type]
        floating_population=result.floating_population,
        building_count_surveyed=result.building_count_surveyed,
        total_liters_per_day=breakdown.total_liters_per_day if breakdown else None,
        total_mld=breakdown.total_mld if breakdown else None,
        fire_demand_liters=breakdown.fire_demand_liters if breakdown else None,
        lpcd=result.lpcd,
        lpcd_source=result.lpcd_source,
        line_items=[
            WaterDemandLineItemOut(
                key=item.key,
                label=item.label,
                liters_per_day=item.liters_per_day,
                explanation=item.explanation,
            )
            for item in (breakdown.line_items if breakdown else [])
        ],
        supply_comparison=result.supply_comparison,
        methodology=result.methodology,
        generated_at=result.generated_at,
    )

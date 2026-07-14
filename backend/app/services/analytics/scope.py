"""Shared, read-only Analytics scope helpers.

Every Analytics endpoint uses these helpers so KPIs, charts, maps, tables,
quality findings, and AI summaries stay on the same deterministic scope.
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select

from app.models import Dataset, Feature
from app.services.analytics.readiness import clean_missing_field, field_missing_condition

SeverityBucketName = Literal["low", "medium", "high"]

NOT_RASTER_SAMPLE = Feature.category.is_distinct_from("raster_pixel")
CATEGORY_EXPR = func.coalesce(func.nullif(func.trim(Feature.category), ""), "uncategorized")


def _clean_text_values(
    values: list[str] | None,
    *,
    field_name: str,
    max_length: int = 128,
) -> list[str]:
    cleaned = sorted({value.strip() for value in values or [] if value.strip()})
    if any(len(value) > max_length for value in cleaned):
        raise HTTPException(
            status_code=400,
            detail=f"{field_name} values must be at most {max_length} characters",
        )
    return cleaned


def clean_categories(values: list[str] | None) -> list[str]:
    return _clean_text_values(values, field_name="category")


def clean_wards(values: list[str] | None) -> list[str]:
    return _clean_text_values(values, field_name="ward")


def clean_severity_buckets(values: list[str] | None) -> list[SeverityBucketName]:
    cleaned = sorted({value.strip().lower() for value in values or [] if value.strip()})
    allowed = {"low", "medium", "high"}
    invalid = [value for value in cleaned if value not in allowed]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"severity_bucket must be one of low, medium, high; got {', '.join(invalid)}",
        )
    return cleaned  # type: ignore[return-value]


def feature_conditions(
    dataset_ids: list[uuid.UUID] | None,
    categories: list[str],
    wards: list[str] | None = None,
    severity_buckets: list[SeverityBucketName] | None = None,
    missing_field: str | None = None,
) -> list[object]:
    """Build reusable SQLAlchemy predicates for an Analytics scope.

    All parameters are optional. Empty lists mean "all" and preserve the
    existing API behaviour.
    """
    conditions: list[object] = [NOT_RASTER_SAMPLE]
    if dataset_ids:
        conditions.append(Feature.dataset_id.in_(dataset_ids))
    if categories:
        conditions.append(CATEGORY_EXPR.in_(categories))
    if wards:
        dataset_scope = select(Dataset.id).where(Dataset.ward.in_(wards))
        conditions.append(Feature.dataset_id.in_(dataset_scope))
    if severity_buckets:
        bucket_conditions: list[object] = []
        if "low" in severity_buckets:
            bucket_conditions.append(Feature.severity < 0.34)
        if "medium" in severity_buckets:
            bucket_conditions.append(and_(Feature.severity >= 0.34, Feature.severity < 0.67))
        if "high" in severity_buckets:
            bucket_conditions.append(Feature.severity >= 0.67)
        conditions.append(or_(*bucket_conditions))
    cleaned_missing_field = clean_missing_field(missing_field)
    if cleaned_missing_field:
        conditions.append(field_missing_condition(cleaned_missing_field))
    return conditions

"""Pydantic payloads for the collaboration/workflow endpoints."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models import ActivityAction, ReviewPriority, ReviewStatus


# ---------- Review items --------------------------------------------------
class ReviewItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    feature_id: uuid.UUID
    title: str
    description: str | None = None
    priority: int
    status: ReviewStatus
    assigned_to: uuid.UUID | None = None
    created_by: uuid.UUID | None = None
    first_response_at: datetime | None = None
    resolved_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class ReviewItemCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4096)
    priority: int = Field(default=int(ReviewPriority.P2), ge=0, le=4)
    assigned_to: uuid.UUID | None = None


class ReviewStatusUpdate(BaseModel):
    status: ReviewStatus


# ---------- Comments ------------------------------------------------------
class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=4096)
    parent_id: uuid.UUID | None = None


class CommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    feature_id: uuid.UUID
    review_item_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None
    author_id: uuid.UUID | None = None
    author_name: str | None = None
    body: str
    created_at: datetime


class CommentWithMentions(BaseModel):
    comment: CommentOut
    notified_user_ids: list[uuid.UUID] = Field(default_factory=list)


# ---------- Feature versions ----------------------------------------------
class FeatureVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    feature_id: uuid.UUID
    version: int
    change_note: str | None = None
    edited_by: uuid.UUID | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


# ---------- Survey requests -----------------------------------------------
class SurveyRequestCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    reason: str | None = Field(default=None, max_length=2048)
    ward: str | None = Field(default=None, max_length=128)
    priority: int = Field(default=2, ge=0, le=4)
    latitude: float = Field(ge=-90.0, le=90.0)
    longitude: float = Field(ge=-180.0, le=180.0)


class SurveyRequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    reason: str | None = None
    ward: str | None = None
    priority: int
    status: str
    latitude: float
    longitude: float
    requested_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


# ---------- Activity log --------------------------------------------------
class ActivityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    actor_id: uuid.UUID | None = None
    actor_name: str | None = None
    action: ActivityAction
    entity_type: str | None = None
    entity_id: uuid.UUID | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


# ---------- Analytics -----------------------------------------------------
class WardBreakdown(BaseModel):
    ward: str
    feature_count: int
    open_reviews: int
    resolved_reviews: int


class StatusBreakdown(BaseModel):
    status: ReviewStatus
    count: int


class CategoryBreakdown(BaseModel):
    category: str
    count: int
    avg_severity: float


class SeverityBucket(BaseModel):
    bucket: Literal["low", "medium", "high"]
    count: int


class IngestionTrendPoint(BaseModel):
    """One real day on which at least one dataset was uploaded — NOT a
    simulated/interpolated point. Used to chart genuine growth in survey
    coverage over time from each dataset's actual `created_at` timestamp."""

    date: str  # YYYY-MM-DD
    features_added: int
    cumulative_features: int


class AnalyticsFeatureRow(BaseModel):
    id: uuid.UUID
    dataset_id: uuid.UUID
    dataset_name: str
    ward: str | None = None
    label: str | None = None
    category: str
    severity: float
    geometry_type: str
    created_at: datetime


class AnalyticsFeaturePage(BaseModel):
    total: int
    limit: int
    offset: int
    rows: list[AnalyticsFeatureRow]


class AnalyticsOverview(BaseModel):
    total_datasets: int
    ready_datasets: int
    processing_datasets: int
    failed_datasets: int
    total_features: int
    average_severity: float
    total_review_items: int
    open_reviews: int
    resolved_reviews: int
    status_breakdown: list[StatusBreakdown]
    ward_breakdown: list[WardBreakdown]
    category_breakdown: list[CategoryBreakdown]
    severity_breakdown: list[SeverityBucket]
    ingestion_trend: list[IngestionTrendPoint]
    generated_at: datetime


class AnalyticsQualityComponent(BaseModel):
    key: str
    label: str
    score: float
    weight: int
    passed: int
    failed: int
    explanation: str


class AnalyticsFinding(BaseModel):
    id: str
    title: str
    description: str
    rule: str
    severity: Literal["low", "medium", "high", "critical"]
    finding_type: Literal["geometry", "attribute", "consistency", "operational"]
    affected_count: int
    affected_percentage: float
    priority_score: int
    feature_ids: list[uuid.UUID] = Field(default_factory=list)
    category: str | None = None
    attribute: str | None = None


class AnalyticsQualityReport(BaseModel):
    total_features: int
    overall_score: float | None
    components: list[AnalyticsQualityComponent]
    findings: list[AnalyticsFinding]
    methodology: str
    generated_at: datetime


# ---------- Notifications -------------------------------------------------
class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source: Literal[
        "comment_mention", "review_assigned", "review_status_changed", "survey_requested"
    ]
    message: str
    feature_id: uuid.UUID | None = None
    source_id: uuid.UUID | None = None
    actor_id: uuid.UUID | None = None
    read_at: datetime | None = None
    created_at: datetime

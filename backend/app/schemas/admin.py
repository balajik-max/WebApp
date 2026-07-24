"""Pydantic payloads for the admin system-monitoring endpoints."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel


class ServiceProbe(BaseModel):
    status: str  # "ok" | "error" | "unavailable"
    detail: str | None = None


class SecurityInfo(BaseModel):
    csrf_protection: bool
    rate_limit_max: int
    rate_limit_window_seconds: int
    failed_login_tracking: bool


class AdminServicesOut(BaseModel):
    api: ServiceProbe
    database: ServiceProbe
    storage: ServiceProbe
    ai_engine: ServiceProbe
    disk_used_percent: float | None
    backups: ServiceProbe
    security: SecurityInfo


class DatasetStatusCounts(BaseModel):
    uploaded: int
    queued: int
    processing: int
    ready: int
    failed: int


class FailedDatasetOut(BaseModel):
    id: uuid.UUID
    name: str
    processing_error: str | None
    updated_at: datetime


class AdminDatasetsOut(BaseModel):
    counts: DatasetStatusCounts
    recent_failures: list[FailedDatasetOut]


class StuckWorkflowOut(BaseModel):
    id: uuid.UUID
    feature_id: uuid.UUID
    workflow_status: str
    updated_at: datetime
    hours_stuck: float


class AdminWorkflowsOut(BaseModel):
    open_point_verifications: int
    stuck_point_verifications: list[StuckWorkflowOut]
    blocked_review_items: int
    open_p0_review_items: int


class ActivityEntryOut(BaseModel):
    id: uuid.UUID
    actor_name: str | None
    actor_role: str | None
    action: str
    entity_type: str | None
    created_at: datetime


class UserRoleCount(BaseModel):
    role: str
    count: int


class AdminActivityOut(BaseModel):
    total_users: int
    active_users: int
    """Number of distinct users that have logged in within the last
    ``active_users_window_minutes`` (defaults to 15). Drives the
    "Active Users" tile in the Admin → Users & Activity section."""
    active_users_window_minutes: int = 15
    users_by_role: list[UserRoleCount]
    recent_logins: list[ActivityEntryOut]
    recent_events: list[ActivityEntryOut]

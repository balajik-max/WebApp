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
    actor_id: uuid.UUID | None = None
    actor_name: str | None
    actor_role: str | None
    action: str
    entity_type: str | None
    created_at: datetime
    ip_address: str | None = None
    user_agent: str | None = None
    payload: dict = {}


class UserRoleCount(BaseModel):
    role: str
    count: int


class SessionOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    user_name: str
    user_role: str
    ip_address: str | None
    user_agent: str | None
    device_category: str
    screen_width: int | None = None
    screen_height: int | None = None
    orientation: str | None = None
    login_at: datetime
    last_seen_at: datetime
    logout_at: datetime | None
    duration_minutes: float
    is_active: bool


class AdminActivityOut(BaseModel):
    total_users: int
    active_users: int
    """Number of distinct users with an open session whose last heartbeat
    fell within the last ``active_users_window_minutes`` (defaults to 15).
    Drives the "Active Users" tile in the Admin → Users & Activity section."""
    active_users_window_minutes: int = 15
    users_by_role: list[UserRoleCount]
    recent_logins: list[ActivityEntryOut]
    active_sessions: list[SessionOut] = []


class AdminSessionsOut(BaseModel):
    sessions: list[SessionOut]


class UserSummaryOut(BaseModel):
    id: uuid.UUID
    name: str
    email: str
    role: str
    is_active: bool
    created_at: datetime


class UserActivityStatsOut(BaseModel):
    total_sessions: int
    total_events: int
    total_logins: int
    is_online: bool
    current_ip: str | None
    current_device: str | None
    current_location: str | None = None
    current_device_category: str | None = None
    current_screen_width: int | None = None
    current_screen_height: int | None = None
    current_orientation: str | None = None


class AdminUserActivityOut(BaseModel):
    user: UserSummaryOut
    stats: UserActivityStatsOut
    sessions: list[SessionOut]
    events: list[ActivityEntryOut]

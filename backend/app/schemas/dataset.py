"""Pydantic response payloads for the datasets API."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict

from app.models import DatasetFileType, DatasetStatus


class DatasetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None = None
    ward: str | None = None
    survey_date: date | None = None
    file_type: DatasetFileType
    status: DatasetStatus
    storage_key: str | None = None
    size_bytes: int | None = None
    processing_error: str | None = None
    dataset_metadata: dict = {}
    created_at: datetime
    updated_at: datetime


class DatasetUpdate(BaseModel):
    ward: str | None = None
    description: str | None = None


class WardOption(BaseModel):
    ward: str
    dataset_count: int
    feature_count: int


class DatasetUploadAccepted(BaseModel):
    """Response body for a `202 Accepted` upload — the client polls
    `GET /api/v1/datasets/{id}` for status transitions."""

    dataset: DatasetOut
    poll_url: str


class SourceCrsAssign(BaseModel):
    """Request body for assigning a CRS to a point cloud dataset after upload."""
    crs: str


class SourceCrsResponse(BaseModel):
    """Response after successfully assigning a CRS."""
    dataset_id: uuid.UUID
    source_crs: str
    crs_status: str
    georeferenced: bool
    message: str

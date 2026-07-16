"""Pydantic payloads for user placemarks."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class PlacemarkCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=5000)
    category: str | None = Field(default=None, max_length=128)
    icon: str = Field(default="pin", min_length=1, max_length=64)
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-90, le=90)
    altitude: float | None = None
    dataset_id: uuid.UUID | None = None
    is_visible: bool = True


class PlacemarkUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=5000)
    category: str | None = Field(default=None, max_length=128)
    icon: str | None = Field(default=None, min_length=1, max_length=64)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    altitude: float | None = None
    dataset_id: uuid.UUID | None = None
    is_visible: bool | None = None


class PlacemarkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    owner_id: uuid.UUID
    dataset_id: uuid.UUID | None
    name: str
    description: str | None
    category: str | None
    icon: str
    longitude: float
    latitude: float
    altitude: float | None
    is_visible: bool
    created_at: datetime
    updated_at: datetime


class PlacemarkBulkDelete(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)


class PlacemarkBulkDeleteResult(BaseModel):
    deleted: int

"""Schemas for map-context coordinate utilities."""
from __future__ import annotations

import math

from pydantic import BaseModel, Field, field_validator


class CoordinateTransformRequest(BaseModel):
    x: float = Field(description="Source CRS X coordinate / easting")
    y: float = Field(description="Source CRS Y coordinate / northing")
    source_crs: str = Field(min_length=3, max_length=2048)
    target_crs: str = Field(default="EPSG:4326", min_length=3, max_length=2048)

    @field_validator("x", "y")
    @classmethod
    def coordinate_must_be_finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("Coordinate must be finite")
        return value

    @field_validator("source_crs", "target_crs")
    @classmethod
    def crs_must_not_be_blank(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("CRS must not be blank")
        return normalized


class CoordinateTransformResponse(BaseModel):
    source_x: float
    source_y: float
    source_crs: str
    longitude: float
    latitude: float
    target_crs: str = "EPSG:4326"

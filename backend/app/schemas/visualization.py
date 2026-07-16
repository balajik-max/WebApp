"""Pydantic contracts for the universal visualization manifest."""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field


VisualizationRenderer = Literal["point", "line", "polygon", "generic"]
VisualizationFieldType = Literal[
    "string",
    "number",
    "boolean",
    "object",
    "array",
    "mixed",
    "unknown",
]


class VisualizationFieldProfile(BaseModel):
    name: str
    detected_type: VisualizationFieldType = "unknown"
    populated_count: int = 0
    missing_count: int = 0
    unique_count: int | None = None


class VisualizationLayerManifest(BaseModel):
    layer_key: str
    source_layer_name: str
    display_name: str
    geometry_types: list[str] = Field(default_factory=list)
    feature_count: int = 0
    bounds: list[float] | None = None
    fields: list[VisualizationFieldProfile] = Field(default_factory=list)
    recommended_renderer: VisualizationRenderer = "generic"
    recommended_modes: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class VisualizationManifest(BaseModel):
    dataset_id: uuid.UUID
    dataset_name: str
    source_format: str
    source_crs: str | None = None
    display_crs: str = "EPSG:4326"
    bounds: list[float] | None = None
    total_features: int = 0
    layers: list[VisualizationLayerManifest] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
"""Pydantic contracts for universal visualization, layer review, and dashboards."""
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
LayerReviewStatus = Literal["auto", "needs_review", "confirmed"]


class VisualizationFieldProfile(BaseModel):
    name: str
    detected_type: VisualizationFieldType = "unknown"
    populated_count: int = 0
    missing_count: int = 0
    unique_count: int | None = None


class VisualizationLayerGroup(BaseModel):
    """One source layer and the attributes that belong to it."""

    name: str
    fields: list[VisualizationFieldProfile] = Field(default_factory=list)


class VisualizationGeometryGroup(BaseModel):
    """Source layers grouped under Points, Lines, or Polygon."""

    name: str
    layers: list[VisualizationLayerGroup] = Field(default_factory=list)


class VisualizationFieldGroupTree(BaseModel):
    """Hierarchy used by the existing attribute-selection UI."""

    datasource: str
    geometry_groups: list[VisualizationGeometryGroup] = Field(default_factory=list)


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

    # Additive Layer Review metadata. Existing map/attribute consumers can
    # ignore these fields without changing their behavior.
    dashboard_type: str = "generic"
    classification_confidence: float = 0.0
    classification_reasons: list[str] = Field(default_factory=list)
    review_status: LayerReviewStatus = "auto"
    included: bool = True
    ingestion_status: str = "ready"
    source_feature_count: int | None = None
    ingestion_warning: str | None = None


class VisualizationManifest(BaseModel):
    dataset_id: uuid.UUID
    dataset_name: str
    source_format: str
    source_crs: str | None = None
    display_crs: str = "EPSG:4326"
    bounds: list[float] | None = None
    total_features: int = 0
    layers: list[VisualizationLayerManifest] = Field(default_factory=list)
    field_groups: VisualizationFieldGroupTree | None = None
    warnings: list[str] = Field(default_factory=list)


class LayerReviewUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=160)
    dashboard_type: str | None = Field(default=None, max_length=64)
    included: bool | None = None
    confirmed: bool = True


class DashboardValueCount(BaseModel):
    label: str
    count: int


class DashboardNumericSummary(BaseModel):
    field: str
    count: int = 0
    minimum: float | None = None
    maximum: float | None = None
    average: float | None = None


class DashboardLayerSummary(BaseModel):
    layer_key: str
    display_name: str
    dashboard_type: str
    geometry_types: list[str] = Field(default_factory=list)
    feature_count: int = 0
    completeness_percentage: float = 100.0
    issue_count: int = 0
    category_breakdown: list[DashboardValueCount] = Field(default_factory=list)
    status_field: str | None = None
    status_breakdown: list[DashboardValueCount] = Field(default_factory=list)
    numeric_summaries: list[DashboardNumericSummary] = Field(default_factory=list)
    fields: list[VisualizationFieldProfile] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class UniversalDashboard(BaseModel):
    dataset_id: uuid.UUID
    dataset_name: str
    total_features: int = 0
    included_layers: int = 0
    point_features: int = 0
    line_features: int = 0
    polygon_features: int = 0
    issue_count: int = 0
    missing_values: int = 0
    profiled_values: int = 0
    geometry_breakdown: list[DashboardValueCount] = Field(default_factory=list)
    dashboard_types: list[DashboardValueCount] = Field(default_factory=list)
    layers: list[DashboardLayerSummary] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)

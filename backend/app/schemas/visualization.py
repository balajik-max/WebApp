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


class VisualizationFieldProfile(BaseModel):
    name: str
    detected_type: VisualizationFieldType = "unknown"
    populated_count: int = 0
    missing_count: int = 0
    unique_count: int | None = None


class VisualizationLayerGroup(BaseModel):
    """A single source layer (feature class) and the attributes it owns.

    Fields are kept verbatim on their original layer — they are never merged or
    flattened into a single list — so the hierarchy Geometry → Layer →
    Attributes is preserved exactly as it exists in the source data.
    """

    name: str
    fields: list[VisualizationFieldProfile] = Field(default_factory=list)


class VisualizationGeometryGroup(BaseModel):
    """Attributes of one geometry type, bucketed by their source layer."""

    name: str  # "Points" | "Lines" | "Polygon"
    layers: list[VisualizationLayerGroup] = Field(default_factory=list)


class VisualizationFieldGroupTree(BaseModel):
    """Hierarchical attribute tree for a data source.

    Structure: ``datasource → geometryGroups → layers → fields``. This is the
    single source of truth for the attribute-selection UI; the flat
    ``VisualizationLayerManifest.fields`` lists are retained unchanged for
    other consumers (styling, AI detection, mapping) but are NOT rendered as a
    flat list by the attribute-selection workflow.
    """

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


class VisualizationManifest(BaseModel):
    dataset_id: uuid.UUID
    dataset_name: str
    source_format: str
    source_crs: str | None = None
    display_crs: str = "EPSG:4326"
    bounds: list[float] | None = None
    total_features: int = 0
    layers: list[VisualizationLayerManifest] = Field(default_factory=list)
    # Hierarchical attribute tree generated from the data source's layers
    # (geometry type → source layer → fields). When present and non-empty the
    # UI renders a 3-level tree; ``None``/empty means no tree is available and
    # the flat ``fields`` list is used as a fallback.
    field_groups: VisualizationFieldGroupTree | None = None
    warnings: list[str] = Field(default_factory=list)
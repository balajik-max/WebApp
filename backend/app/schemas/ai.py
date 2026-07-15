"""
Pydantic payloads for the grounded RAG endpoints.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------- Requests ------------------------------------------------------
class NLQueryRequest(BaseModel):
    """Natural language question with optional grounding hints."""

    question: str = Field(min_length=3, max_length=2000)
    dataset_id: uuid.UUID | None = None
    ward: str | None = Field(default=None, max_length=128)
    category: str | None = Field(default=None, max_length=128)
    feature_ids: list[uuid.UUID] = Field(default_factory=list, max_length=25)
    max_features: int = Field(default=60, ge=1, le=200)


class RecommendRequest(BaseModel):
    """Recommend mitigation actions for a single feature."""

    feature_id: uuid.UUID


class ReportRequest(BaseModel):
    """Generate a grounded planning report for a ward or Analytics scope.

    ``dataset_id`` is retained for the existing Map report panel. Analytics
    uses the repeatable ``dataset_ids`` and ``categories`` fields.
    """

    dataset_id: uuid.UUID | None = None
    dataset_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)
    ward: str | None = Field(default=None, max_length=128)
    categories: list[str] = Field(default_factory=list, max_length=500)
    all_datasets: bool = False
    max_features: int = Field(default=120, ge=1, le=300)


class SpacingRequest(BaseModel):
    """Check whether features of one category (e.g. Power Pole) are
    unusually close together within a ward/dataset — a real distance
    computation, not a guess. Exactly one scope (ward or dataset) required."""

    dataset_id: uuid.UUID | None = None
    ward: str | None = Field(default=None, max_length=128)
    category: str = Field(min_length=1, max_length=128)
    distance_m: float = Field(default=200.0, ge=1.0, le=5000.0)


class ManholeRecommendRequest(BaseModel):
    """`feature` mode recommends for one specific manhole (condition, level,
    or connectivity issue); `area` mode scans the whole dataset for
    disconnected manholes and drain-coverage gaps; `network` mode builds
    the complete manhole-to-manhole drainage layout with real, elevation-
    grounded flow direction (DTM raster -> nearest contour -> surveyed
    invert, in that priority order — terrain elevation is smoother and more
    internally consistent than the hand-surveyed levels, so it comes first)."""

    mode: Literal["feature", "area", "network"]
    dataset_id: uuid.UUID
    feature_id: uuid.UUID | None = None


# ---------- Response ------------------------------------------------------
class NeededLocation(BaseModel):
    id: str
    lon: float
    lat: float
    reason: str


class PipeSpecOut(BaseModel):
    material: str
    diameter_mm: float
    from_rl: float | None
    to_rl: float | None
    slope: float | None


class PipeRouteOut(BaseModel):
    from_id: str
    to_id: str | None
    coordinates: list[list[float]]  # [[lon, lat], ...]
    pipe_spec: PipeSpecOut
    # network-mode only: which real source grounded the elevation used for
    # flow direction (surveyed_invert / dtm_raster / nearest_contour /
    # unknown), and whether a direction could actually be confirmed (both
    # ends had a real elevation) rather than just drawn without one.
    elevation_source: str | None = None
    flow_confirmed: bool | None = None
    # If true, this manhole should be closed during rainy season to prevent
    # water from spreading (based on condition, elevation, or blockage risk).
    rainy_season_closed: bool | None = None
    # network-mode only: "sewage_line" when this route follows a real
    # surveyed sewage/drain pipe, "concrete_road" when no such pipe path
    # existed and it instead follows the concrete road network as a stated
    # assumption — never left ambiguous which one grounds a given line.
    route_basis: str | None = None


class AiAnswer(BaseModel):
    kind: Literal["query", "recommend", "report", "spacing", "manhole_recommend"]
    model: str
    prompt_tokens_hint: int
    context_rows: int
    grounded: bool
    answer_markdown: str
    generated_at: datetime
    disclaimer: str | None = None
    debug: dict[str, Any] | None = None
    # Spacing-specific: AI-classified feature IDs for map highlighting.
    # redundant_feature_ids — poles the AI recommends removing (show red).
    # needed_feature_ids   — poles that are structurally required (show green).
    # Both are empty lists for non-spacing answers.
    redundant_feature_ids: list[str] = Field(default_factory=list)
    needed_feature_ids: list[str] = Field(default_factory=list)
    needed_locations: list[NeededLocation] = Field(default_factory=list)
    # manhole_recommend-specific: proposed/rehab pipe routes with real
    # coordinates and specs. Empty list for every other answer kind.
    routes: list[PipeRouteOut] = Field(default_factory=list)
    # network mode only: manholes with no real sewage/drain pipe within
    # reach (see PIPE_SNAP_TOLERANCE_M) — these get no route at all rather
    # than a fabricated straight-line connection. Empty for every other kind.
    unconnected_manholes: list[NeededLocation] = Field(default_factory=list)


# ---------- Spatial audit engine (Phase 1) --------------------------------
class AuditRunRequest(BaseModel):
    dataset_id: uuid.UUID


class AuditRunResponse(BaseModel):
    dataset_id: uuid.UUID
    ward: str | None
    pole_redundancy: dict[str, int]
    drain_encroachment: dict[str, int]
    manhole_status: dict[str, int]


class SpatialAnomalyOut(BaseModel):
    id: uuid.UUID
    dataset_id: uuid.UUID
    ward: str | None
    anomaly_type: str
    color: str
    severity_score: float
    status: str
    lon: float
    lat: float
    feature_ids: list[uuid.UUID]
    anomaly_metadata: dict[str, Any]
    explanation_text: str | None
    created_at: datetime


class AnomalyExplainResponse(BaseModel):
    id: uuid.UUID
    explanation_text: str
    explanation_model: str
    cached: bool


class AnomalyStatusUpdate(BaseModel):
    status: Literal["open", "reviewing", "resolved", "dismissed"]

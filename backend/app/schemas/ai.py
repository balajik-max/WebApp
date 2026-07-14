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


# ---------- Response ------------------------------------------------------
class NeededLocation(BaseModel):
    id: str
    lon: float
    lat: float
    reason: str


class AiAnswer(BaseModel):
    kind: Literal["query", "recommend", "report", "spacing"]
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

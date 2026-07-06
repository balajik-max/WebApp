"""
Pydantic payloads for the grounded RAG endpoints.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------- Requests ------------------------------------------------------
class SummarizeRequest(BaseModel):
    """Summarize a dataset or a ward.  Exactly one scope required."""

    dataset_id: uuid.UUID | None = None
    ward: str | None = Field(default=None, max_length=128)
    max_features: int = Field(default=80, ge=1, le=300)


class NLQueryRequest(BaseModel):
    """Natural language question with optional grounding hints."""

    question: str = Field(min_length=3, max_length=2000)
    dataset_id: uuid.UUID | None = None
    ward: str | None = Field(default=None, max_length=128)
    feature_ids: list[uuid.UUID] = Field(default_factory=list, max_length=25)
    max_features: int = Field(default=60, ge=1, le=200)


class PrioritizeRequest(BaseModel):
    """Prioritize the current backlog of open review items."""

    ward: str | None = Field(default=None, max_length=128)
    limit: int = Field(default=25, ge=1, le=100)


class RecommendRequest(BaseModel):
    """Recommend mitigation actions for a single feature."""

    feature_id: uuid.UUID


# ---------- Response ------------------------------------------------------
class AiAnswer(BaseModel):
    kind: Literal["summarize", "query", "prioritize", "recommend"]
    model: str
    prompt_tokens_hint: int
    context_rows: int
    grounded: bool
    answer_markdown: str
    generated_at: datetime
    disclaimer: str | None = None
    debug: dict[str, Any] | None = None

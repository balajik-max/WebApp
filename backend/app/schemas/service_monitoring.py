"""
Pydantic response models for the grouped Services monitoring endpoint.

The Admin Services UI needs many distinct kinds of items (full service cards,
internal capability rows, resource metrics, configuration status rows) but
they all share a common envelope so the frontend can render the same grouping
component regardless of ``kind``. The status enum is the single source of
truth for both backend probes and frontend badges — see
``ServiceMonitoringStatus`` for the allowed values and the
``map_legacy_status()`` helper in the health module for boundary mapping.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# --- Status enum ---------------------------------------------------------
# Authoritative on both sides of the API. The frontend must render only
# these strings — legacy "ok"/"error"/"unavailable" tokens used by the
# older ``/api/v1/admin/services`` payload are mapped to one of these at
# the backend boundary and never reach the new UI.
ServiceMonitoringStatus = Literal[
    "healthy",
    "degraded",
    "critical",
    "offline",
    "unknown",
    "not_configured",
    "disabled",
    "partial",
]

# --- Service kind enum ---------------------------------------------------
# ``kind`` controls how the frontend renders the row (full card vs compact
# row vs resource metric vs configuration warning).
ServiceMonitoringKind = Literal[
    "service",
    "subsystem",
    "capability",
    "resource",
    "configuration",
    "external_dependency",
]

# --- Criticality ---------------------------------------------------------
ServiceCriticality = Literal["critical", "high", "medium", "low"]


class ServiceMonitoringItem(BaseModel):
    """One row inside a service group.

    Items range from a full ``service`` (Frontend, Backend, Database, …) to a
    compact ``capability`` row under AI Engine (e.g. "Embeddings"). The
    frontend picks the row template from ``kind``; everything else is just
    display data and copy.
    """

    key: str
    name: str
    kind: ServiceMonitoringKind
    status: ServiceMonitoringStatus
    criticality: ServiceCriticality
    description: str

    # The one metric the card promotes into the headline tile. Optional so
    # resource rows and configuration rows can simply omit it.
    primary_metric: dict[str, Any] | None = None

    # ``response_time_ms`` is shown in the card meta line for services with
    # active probes; null for static configuration rows and capability rows.
    response_time_ms: float | None = None

    # Human label for the path or endpoint the probe hit — never the
    # secret/credential portion. Examples: "http://ai_engine:11434" or
    # "minio://urban-survey-datasets".
    endpoint_label: str | None = None

    # ISO-8601 UTC timestamp the probe last returned a result. For static
    # configuration rows the value is null.
    last_checked_at: str | None = None

    # One short, safe-to-display message. Used as the card subtitle / detail
    # line. For errors this is a sanitized version of the probe error (no
    # stack traces, no credentials, no internal paths).
    detail: str | None = None

    # Lists the services this item depends on (for cards) or the parent
    # service (for capability rows). Keys reference other items in the
    # same response, never external identifiers.
    dependencies: list[str] = Field(default_factory=list)

    # Free-form bag for the detail drawer only — never surfaced on the
    # compact card. Includes things like container name, build version,
    # bucket name, configured model names, etc. Sanitized on the way in
    # (no secrets).
    details: dict[str, Any] = Field(default_factory=dict)

    # When the item has a parent group outside its own (e.g. a capability
    # row that belongs to "ai_engine"), this names the parent key. The
    # frontend uses this to render the row as a nested compact row inside
    # the parent's card.
    parent_key: str | None = None


class ServiceMonitoringGroup(BaseModel):
    """One subsection in the Services section, e.g. "Core Platform"."""

    id: str
    label: str
    description: str
    status: ServiceMonitoringStatus
    item_count: int
    items: list[ServiceMonitoringItem]


class ServiceMonitoringSummary(BaseModel):
    """Top-of-page counters for the Overall Services Status card."""

    healthy: int = 0
    degraded: int = 0
    critical: int = 0
    offline: int = 0
    unknown: int = 0
    not_configured: int = 0
    disabled: int = 0
    partial: int = 0


class ServiceMonitoringOut(BaseModel):
    """Top-level response shape for ``GET /api/v1/admin/services``."""

    generated_at: str
    overall_status: ServiceMonitoringStatus
    overall_detail: str | None = None
    summary: ServiceMonitoringSummary
    groups: list[ServiceMonitoringGroup]

    # Convenience flat index for the detail drawer — key → originating
    # group id. The frontend uses this when an item is opened from a
    # drawer so breadcrumbs can be drawn.
    item_index: dict[str, str] = Field(default_factory=dict)

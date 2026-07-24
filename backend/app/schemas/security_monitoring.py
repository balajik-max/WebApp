"""Pydantic payloads for the Admin Security section.

These schemas are the wire contract between ``app/services/security_monitoring.py``
and the React ``AdminSecurity*`` components. The status and severity enums are
the single source of truth used everywhere in the Security UI.

The schemas are deliberately explicit — every field is a primitive, the
detail objects are sanitized, and no string can carry a secret, password,
or full connection string. The service layer is responsible for stripping
sensitive values before they reach the response model.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------

# Per-section control status vocabulary. MUST stay in sync with the
# frontend `SecurityControlStatus` type in `adminMonitoring.ts`.
SecurityStatus = Literal[
    "protected",
    "partially_protected",
    "at_risk",
    "unknown",
    "not_configured",
    "not_applicable",
    "disabled",
]

# Per-finding severity. MUST stay in sync with `SecuritySeverity` in TS.
SecuritySeverity = Literal[
    "critical",
    "high",
    "medium",
    "low",
    "informational",
]

# Posture rollup at the top of the Security page. MUST stay in sync
# with `SecurityPosture` in TS.
SecurityPosture = Literal[
    "protected",
    "partially_protected",
    "at_risk",
    "critical",
    "unknown",
]

# Render flavor for individual controls inside a group. Lets the UI pick
# the right card / row / finding / gap presentation without inferring
# from the status string.
SecurityControlKind = Literal[
    "card",
    "row",
    "finding",
    "gap",
]


# ---------------------------------------------------------------------------
# Sub-models
# ---------------------------------------------------------------------------


class SecuritySummary(BaseModel):
    """Aggregate counts that drive the top-of-section tiles."""

    protected: int = 0
    partially_protected: int = 0
    at_risk: int = 0
    unknown: int = 0
    not_configured: int = 0
    not_applicable: int = 0
    disabled: int = 0
    critical_findings: int = 0
    high_findings: int = 0
    medium_findings: int = 0
    low_findings: int = 0
    informational_findings: int = 0
    total_controls: int = 0
    total_findings: int = 0


class SecurityFindingCounts(BaseModel):
    critical: int = 0
    high: int = 0
    medium: int = 0
    low: int = 0
    informational: int = 0


class SecurityControlDetail(BaseModel):
    """Optional per-control detail payload shown in the details drawer.

    The service layer is responsible for ensuring nothing in here is a
    secret. The drawer MUST display `current_implementation` and
    `known_limitations` only; never the underlying `.env` value.
    """

    current_implementation: str | None = None
    known_limitations: str | None = None
    evidence_source: str | None = None
    affected_components: list[str] = Field(default_factory=list)
    exposure_context: str | None = None
    recommended_remediation: str | None = None
    monitoring_source: str | None = None
    production_impact: str | None = None
    development_impact: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class SecurityControl(BaseModel):
    key: str
    name: str
    kind: SecurityControlKind = "row"
    category: str
    status: SecurityStatus
    severity: SecuritySeverity | None = None
    description: str = ""
    scope: str | None = None
    one_line: str | None = None
    last_assessed_at: datetime | None = None
    details: SecurityControlDetail = Field(default_factory=SecurityControlDetail)
    monitoring_source: str | None = None
    display_order: int = 0


class SecurityFinding(BaseModel):
    id: str
    title: str
    severity: SecuritySeverity
    status: Literal["open", "acknowledged", "resolved"] = "open"
    affected_area: str
    summary: str
    recommendation: str
    evidence_references: list[str] = Field(default_factory=list)
    production_priority: Literal["immediate", "high", "medium", "low"] = "high"
    last_assessed_at: datetime | None = None


class SecurityGroup(BaseModel):
    id: str
    label: str
    description: str = ""
    status: SecurityStatus
    default_open: bool = True
    finding_counts: SecurityFindingCounts = Field(default_factory=SecurityFindingCounts)
    control_counts: dict[str, int] = Field(default_factory=dict)
    items: list[SecurityControl] = Field(default_factory=list)


class SecurityMonitoringOut(BaseModel):
    """Top-level response for ``GET /api/v1/admin/security``."""

    generated_at: datetime
    overall_posture: SecurityPosture
    posture_reason: str
    assessment_source: str = "static_configuration_and_safe_runtime_probes"
    summary: SecuritySummary
    groups: list[SecurityGroup]
    findings: list[SecurityFinding]
    last_assessed_at: datetime
    configuration_snapshot: dict[str, Any] = Field(default_factory=dict)
    partial_failures: list[str] = Field(default_factory=list)

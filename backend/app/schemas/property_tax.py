"""Pydantic payloads for GIS-linked municipal property-tax assessment."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


PropertyTaxStatus = Literal[
    "not_assessed",
    "draft",
    "verification_pending",
    "verified",
    "approved",
    "demand_generated",
]

DiscrepancyStatus = Literal[
    "not_reviewed",
    "no_discrepancy",
    "verification_required",
    "under_review",
    "accepted",
    "corrected",
]


class FloorTaxLine(BaseModel):
    floor_name: str = Field(default="Ground floor", max_length=64)
    property_use: str | None = Field(default=None, max_length=64)
    area_sqm: float = Field(default=0, ge=0, le=100_000_000)
    annual_rate_per_sqm: float | None = Field(default=None, ge=0, le=10_000_000)
    usage_factor: float = Field(default=1.0, ge=0, le=100)


class PropertyTaxAssessmentUpsert(BaseModel):
    status: PropertyTaxStatus = "draft"
    property_id: str | None = Field(default=None, max_length=128)
    assessment_number: str | None = Field(default=None, max_length=128)
    owner_name: str | None = Field(default=None, max_length=255)
    occupancy_status: str | None = Field(default=None, max_length=64)
    construction_type: str | None = Field(default=None, max_length=64)
    tax_zone: str | None = Field(default=None, max_length=32)
    municipal_use: str | None = Field(default=None, max_length=64)
    municipal_plot_area_sqm: float | None = Field(default=None, ge=0, le=100_000_000)
    municipal_built_up_area_sqm: float | None = Field(default=None, ge=0, le=100_000_000)
    municipal_floor_count: int | None = Field(default=None, ge=0, le=300)
    municipal_record_id: uuid.UUID | None = None
    financial_year: str = Field(default="2026-27", min_length=4, max_length=16)
    discrepancy_status: DiscrepancyStatus = "not_reviewed"
    floor_assessments: list[FloorTaxLine] = Field(default_factory=list, max_length=300)
    annual_rate_per_sqm: float | None = Field(default=None, ge=0, le=10_000_000)
    usage_factor: float = Field(default=1.0, ge=0, le=100)
    zone_factor: float = Field(default=1.0, ge=0, le=100)
    construction_factor: float = Field(default=1.0, ge=0, le=100)
    age_factor: float = Field(default=1.0, ge=0, le=100)
    cess_percent: float = Field(default=0.0, ge=0, le=100)
    service_charge: float = Field(default=0.0, ge=0, le=10_000_000_000)
    rebate_amount: float = Field(default=0.0, ge=0, le=10_000_000_000)
    exemption_amount: float = Field(default=0.0, ge=0, le=10_000_000_000)
    base_annual_tax: float | None = Field(default=None, ge=0, le=10_000_000_000)
    estimated_annual_tax: float | None = Field(default=None, ge=0, le=10_000_000_000)
    remarks: str | None = Field(default=None, max_length=10_000)
    gis_snapshot: dict[str, Any] = Field(default_factory=dict)

    @field_validator(
        "property_id",
        "assessment_number",
        "owner_name",
        "occupancy_status",
        "construction_type",
        "tax_zone",
        "municipal_use",
        "remarks",
        mode="before",
    )
    @classmethod
    def blank_to_none(cls, value: Any) -> Any:
        if isinstance(value, str):
            cleaned = value.strip()
            return cleaned or None
        return value


class PropertyTaxAssessmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, use_enum_values=True)

    id: uuid.UUID
    feature_id: uuid.UUID
    dataset_id: uuid.UUID
    created_by_id: uuid.UUID | None
    updated_by_id: uuid.UUID | None
    status: PropertyTaxStatus
    property_id: str | None
    assessment_number: str | None
    owner_name: str | None
    occupancy_status: str | None
    construction_type: str | None
    tax_zone: str | None
    municipal_use: str | None
    municipal_plot_area_sqm: float | None
    municipal_built_up_area_sqm: float | None
    municipal_floor_count: int | None
    municipal_record_id: uuid.UUID | None
    financial_year: str
    discrepancy_status: DiscrepancyStatus
    floor_assessments: list[dict[str, Any]]
    annual_rate_per_sqm: float | None
    usage_factor: float
    zone_factor: float
    construction_factor: float
    age_factor: float
    cess_percent: float
    service_charge: float
    rebate_amount: float
    exemption_amount: float
    base_annual_tax: float | None
    estimated_annual_tax: float | None
    remarks: str | None
    gis_snapshot: dict[str, Any]
    version: int
    created_at: datetime
    updated_at: datetime


class PropertyTaxAssessmentRevisionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    assessment_id: uuid.UUID
    feature_id: uuid.UUID
    dataset_id: uuid.UUID
    changed_by_id: uuid.UUID | None
    version: int
    status: str
    change_reason: str | None
    changed_fields: dict[str, Any]
    snapshot: dict[str, Any]
    created_at: datetime


class MunicipalPropertyRecordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    dataset_id: uuid.UUID | None
    feature_id: uuid.UUID | None
    property_id: str | None
    assessment_number: str | None
    sas_number: str | None
    door_number: str | None
    owner_name: str | None
    owner_mobile: str | None
    address: str | None
    municipal_use: str | None
    occupancy_status: str | None
    construction_type: str | None
    tax_zone: str | None
    municipal_plot_area_sqm: float | None
    municipal_built_up_area_sqm: float | None
    municipal_floor_count: int | None
    annual_rate_per_sqm: float | None
    financial_year: str | None
    source_latitude: float | None
    source_longitude: float | None
    source_name: str
    source_row_number: int | None
    match_method: str | None
    match_confidence: float | None
    linked_at: datetime | None
    created_at: datetime
    updated_at: datetime


class MunicipalRecordImportResponse(BaseModel):
    source_name: str
    imported: int
    linked: int
    exact_linked: int = 0
    spatial_linked: int = 0
    unlinked: int = 0
    skipped: int
    errors: list[str] = Field(default_factory=list)


class MunicipalRecordSearchResponse(BaseModel):
    records: list[MunicipalPropertyRecordOut]
    count: int


class MunicipalRecordLinkRequest(BaseModel):
    copy_to_assessment: bool = True


class PropertyTaxDemandOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    assessment_id: uuid.UUID
    feature_id: uuid.UUID
    dataset_id: uuid.UUID
    generated_by_id: uuid.UUID | None
    financial_year: str
    demand_number: str
    status: str
    base_tax: float
    cess_amount: float
    service_charge: float
    rebate_amount: float
    exemption_amount: float
    total_demand: float
    calculation_breakdown: dict[str, Any]
    generated_at: datetime
    created_at: datetime
    updated_at: datetime

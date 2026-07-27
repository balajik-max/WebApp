"""Pothole and road-surface repair-cost request/response payloads."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

RateMode = Literal["official", "manual"]
RoadSurface = Literal["bituminous", "concrete", "paver", "wbm", "wmm", "gravel", "earthen", "composite", "unknown"]


class PotholeLabourSettingsUpdate(BaseModel):
    enabled: bool = False
    charge_per_pothole_inr: float = Field(default=0.0, ge=0.0, le=10_000_000.0)


class PotholeLabourSettingsOut(BaseModel):
    enabled: bool
    charge_per_pothole_inr: float
    updated_at: datetime | None = None


class PotholeEstimateUpdate(BaseModel):
    rate_mode: RateMode = "official"
    financial_year: str = Field(default="2026-27", pattern=r"^\d{4}-\d{2}$")
    estimate_date: date | None = None
    selected_item_code: str | None = Field(default=None, max_length=32)
    repair_depth_mm: float | None = Field(default=None, ge=0.0, le=5000.0)
    manual_rate_value: float | None = Field(default=None, gt=0.0, le=10_000_000.0)
    manual_rate_unit: Literal["m2", "m3"] = "m2"
    manual_rate_per_sqm: float | None = Field(default=None, gt=0.0, le=10_000_000.0)
    labour_enabled: bool = False
    labour_charge_per_pothole_inr: float = Field(default=0.0, ge=0.0, le=10_000_000.0)
    additional_charge_reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def validate_manual_rate(self) -> "PotholeEstimateUpdate":
        if self.manual_rate_value is None and self.manual_rate_per_sqm is not None:
            self.manual_rate_value = self.manual_rate_per_sqm
            self.manual_rate_unit = "m2"
        if self.rate_mode == "manual" and self.manual_rate_value is None:
            raise ValueError("manual_rate_value is required in manual mode")
        if self.labour_enabled and not (self.additional_charge_reason or "").strip():
            raise ValueError("additional_charge_reason is required when an additional charge is enabled")
        return self


class MaterialBreakdownOut(BaseModel):
    name: str
    quantity: float | None
    quantity_unit: str
    rate: float | None
    rate_unit: str | None
    amount_inr: float | None
    rate_year: str | None
    source_document: str | None
    source_page: int | None
    note: str | None = None
    included_in_finished_rate: bool = True


class PotholeRateOut(BaseModel):
    rate_value: float | None = None
    rate_per_sqm: float | None = None
    unit: str
    source: str
    year: str
    rate_basis_year: str | None = None
    item_code: str
    item_description: str
    effective_from: date | None = None
    source_document: str | None = None
    source_page: int | None = None
    source_url: str | None = None
    status: str
    verified_at: datetime | None = None
    last_sync_error: str | None = None
    gst_included: bool = False
    rate_mode: RateMode


class PotholeCostSettingsOut(BaseModel):
    labour: PotholeLabourSettingsOut
    rate: PotholeRateOut


class PotholeRateSyncOut(BaseModel):
    financial_year: str
    status: str
    documents_found: int = 0
    documents_downloaded: int = 0
    rates_extracted: int = 0
    requires_review: int = 0
    message: str


class FinancialYearOut(BaseModel):
    financial_year: str
    source_url: str | None = None
    cached: bool = True


class RepairOptionOut(BaseModel):
    item_code: str
    label: str
    unit: str
    rate_value: float
    status: str


class PotholeCostEstimateOut(BaseModel):
    anomaly_id: uuid.UUID
    area_sqm: float
    depth_mm: float | None = None
    calculated_quantity: float | None = None
    quantity_unit: str
    road_category: str
    road_surface: RoadSurface
    road_type_source: str | None = None
    pothole_type: Literal["shallow", "deep"]
    recommended_repair_method: str
    financial_year: str
    estimate_date: date
    rate_mode: RateMode
    selected_item_code: str
    available_items: list[RepairOptionOut] = Field(default_factory=list)
    manual_rate_value: float | None = None
    manual_rate_unit: Literal["m2", "m3"] | None = None
    manual_rate_per_sqm: float | None = None
    official_rate_applicable: bool
    base_repair_cost_inr: float | None
    labour_charge_enabled: bool
    labour_charge_per_pothole_inr: float
    additional_charge_reason: str | None = None
    total_repair_cost_inr: float | None
    rate: PotholeRateOut
    materials: list[MaterialBreakdownOut] = Field(default_factory=list)
    material_breakdown_informational_only: bool = True
    calculation_status: str
    calculation_formula: str
    online_refresh_attempted: bool = False
    warning: str | None = None

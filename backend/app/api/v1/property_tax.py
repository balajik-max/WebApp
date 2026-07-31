"""GIS-linked municipal property-tax register, assessment and demand endpoints."""
from __future__ import annotations

import io
import math
import re
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import (
    Feature,
    PropertyTaxAssessment,
    PropertyTaxAssessmentRevision,
    PropertyTaxDemand,
    PropertyTaxMunicipalRecord,
    User,
)
from app.schemas.property_tax import (
    MunicipalPropertyRecordOut,
    MunicipalRecordImportResponse,
    MunicipalRecordLinkRequest,
    MunicipalRecordSearchResponse,
    PropertyTaxAssessmentOut,
    PropertyTaxAssessmentRevisionOut,
    PropertyTaxAssessmentUpsert,
    PropertyTaxDemandOut,
)

router = APIRouter()

IDENTIFIER_ALIASES = {
    "property_id": ["property id", "property_id", "propertyid", "pid", "new pid", "existing pid", "khata no", "khata number"],
    "assessment_number": ["assessment number", "assessment no", "assessment_number", "assessmentno", "assmt no", "assmt number"],
    "sas_number": ["sas number", "sas no", "sas_number", "sasno"],
    "door_number": ["door number", "door no", "door_number", "doorno", "house no", "house number"],
}

COLUMN_ALIASES = {
    **IDENTIFIER_ALIASES,
    "gis_feature_id": ["gis feature id", "gis_feature_id", "feature id", "feature_id", "building feature id"],
    "owner_name": ["owner name", "owner_name", "owner", "property owner", "assessee name", "tax payer name"],
    "owner_mobile": ["owner mobile", "mobile", "mobile number", "phone", "contact number"],
    "address": ["address", "property address", "postal address", "street address"],
    "municipal_use": ["property use", "building use", "usage", "use type", "classification", "property_type", "property type"],
    "occupancy_status": ["occupancy", "occupancy status", "tenure", "occupied by"],
    "construction_type": ["construction type", "building type", "structure type", "construction"],
    "tax_zone": ["tax zone", "zone", "value zone", "property zone"],
    "municipal_plot_area_sqm": ["plot area", "plot area sqm", "site area", "property area", "plot extent"],
    "municipal_built_up_area_sqm": ["built up area", "built-up area", "builtup area", "taxable area", "building area"],
    "municipal_floor_count": ["floor count", "number of floors", "no of floors", "floors", "total floors"],
    "annual_rate_per_sqm": ["annual rate per sqm", "rate per sqm", "tax rate", "annual rate", "rate"],
    "financial_year": ["financial year", "fy", "assessment year", "tax year"],
    "source_latitude": ["latitude", "lat", "property latitude", "building latitude", "y"],
    "source_longitude": ["longitude", "lon", "lng", "property longitude", "building longitude", "x"],
}

FEATURE_ID_ALIASES = [alias for values in IDENTIFIER_ALIASES.values() for alias in values]


def _normalize_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _clean_text(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null", "na", "n/a"}:
        return None
    if re.fullmatch(r"\d+\.0", text):
        text = text[:-2]
    return text


def _canonical_property_use(value: Any) -> str | None:
    cleaned = _clean_text(value)
    if cleaned is None:
        return None
    normalized = _normalize_key(cleaned)
    if any(token in normalized for token in ("mixed", "residentialcommercial", "commercialresidential", "rescom", "comres")):
        return "Mixed Use"
    if normalized in {"r", "res", "residential", "house", "home", "dwelling"} or "residential" in normalized:
        return "Residential"
    if normalized in {"c", "com", "commercial", "shop", "retail", "office", "business"} or any(token in normalized for token in ("commercial", "retail", "shop", "office", "hotel")):
        return "Commercial"
    if normalized in {"i", "ind", "industrial", "factory", "warehouse"} or "industrial" in normalized:
        return "Industrial"
    if any(token in normalized for token in ("public", "semipublic", "institution", "government", "school", "hospital")):
        return "Public & Semi Public"
    if any(token in normalized for token in ("dilapidated", "ruin", "abandoned")):
        return "Dilapidated"
    if any(token in normalized for token in ("underconstruction", "construction")):
        return "Under Construction"
    if any(token in normalized for token in ("vacantplot", "vacantland", "emptyplot")):
        return "Vacant Plot"
    if any(token in normalized for token in ("exempt", "religious", "temple", "mosque", "church")):
        return "Exempt"
    return cleaned


def _canonical_occupancy(value: Any) -> str | None:
    cleaned = _clean_text(value)
    if cleaned is None:
        return None
    normalized = _normalize_key(cleaned)
    if any(token in normalized for token in ("owneroccupied", "selfoccupied", "selfuse")):
        return "Owner occupied"
    if any(token in normalized for token in ("partiallyrented", "partlyrented", "mixedoccupancy")):
        return "Partially rented"
    if any(token in normalized for token in ("fullyrented", "fullrental")):
        return "Fully rented"
    if any(token in normalized for token in ("tenantoccupied", "rented", "leased")):
        return "Tenant occupied"
    if normalized in {"vacant", "unoccupied", "empty"}:
        return "Vacant"
    if any(token in normalized for token in ("locked", "notaccessed")):
        return "Locked during survey"
    if "underconstruction" in normalized:
        return "Under construction"
    if any(token in normalized for token in ("abandoned", "disused")):
        return "Abandoned"
    return cleaned


def _canonical_construction(value: Any) -> str | None:
    cleaned = _clean_text(value)
    if cleaned is None:
        return None
    normalized = _normalize_key(cleaned)
    if any(token in normalized for token in ("rcc", "reinforcedcement", "framed")):
        return "RCC framed"
    if any(token in normalized for token in ("loadbearing",)):
        return "Load bearing"
    if normalized in {"p", "pucca", "permanent"} or "pucca" in normalized:
        return "Pucca"
    if normalized in {"sp", "semipucca", "semipermanent"} or "semipucca" in normalized:
        return "Semi-pucca"
    if normalized in {"k", "kutcha", "temporarymud"} or "kutcha" in normalized:
        return "Kutcha"
    if any(token in normalized for token in ("tinroof", "sheetroof", "asbestos")):
        return "Tin / sheet roof"
    if any(token in normalized for token in ("dilapidated", "unsafe")):
        return "Dilapidated"
    if "temporary" in normalized:
        return "Temporary"
    return cleaned


def _number(value: Any) -> float | None:
    cleaned = _clean_text(value)
    if cleaned is None:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", cleaned.replace(",", ""))
    if not match:
        return None
    parsed = float(match.group(0))
    return parsed if math.isfinite(parsed) and parsed >= 0 else None


def _signed_number(value: Any) -> float | None:
    cleaned = _clean_text(value)
    if cleaned is None:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", cleaned.replace(",", ""))
    if not match:
        return None
    parsed = float(match.group(0))
    return parsed if math.isfinite(parsed) else None


def _integer(value: Any) -> int | None:
    parsed = _number(value)
    return None if parsed is None else int(round(parsed))



def _haversine_metres(latitude_a: float, longitude_a: float, latitude_b: float, longitude_b: float) -> float:
    """Return great-circle distance for import-time nearest-building matching."""
    radius = 6_371_008.8
    lat1 = math.radians(latitude_a)
    lat2 = math.radians(latitude_b)
    delta_lat = lat2 - lat1
    delta_lon = math.radians(longitude_b - longitude_a)
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(value), math.sqrt(max(0.0, 1 - value)))


def _looks_like_building(feature: Feature) -> bool:
    attributes = feature.attributes or {}
    key_text = " ".join(str(key).lower() for key in attributes)
    value_text = " ".join(str(value).lower() for value in attributes.values() if value is not None)
    identity = " ".join(filter(None, [str(feature.category or "").lower(), str(feature.label or "").lower(), key_text]))
    excluded = ("ward boundary", "road boundary", "road center", "drain", "manhole", "utility", "parcel", "plot boundary")
    if any(token in identity for token in excluded) and "building" not in identity:
        return False
    if "building" in identity or "structure" in identity:
        return True
    building_keys = ("buildinguse", "bldguse", "buildingtype", "bldgtype", "structureuse", "nooffloors", "numberoffloors", "builtuparea", "flooruse")
    if any(token in _normalize_key(key_text) for token in building_keys):
        return True
    return any(token in value_text for token in ("residential", "commercial", "mixed use", "industrial", "dilapidated"))


ASSESSMENT_REVISION_FIELDS = (
    "status", "property_id", "assessment_number", "owner_name", "occupancy_status",
    "construction_type", "tax_zone", "municipal_use", "municipal_plot_area_sqm",
    "municipal_built_up_area_sqm", "municipal_floor_count", "municipal_record_id",
    "financial_year", "discrepancy_status", "floor_assessments", "annual_rate_per_sqm",
    "usage_factor", "zone_factor", "construction_factor", "age_factor", "cess_percent",
    "service_charge", "rebate_amount", "exemption_amount", "base_annual_tax",
    "estimated_annual_tax", "remarks", "gis_snapshot",
)


def _json_value(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "value"):
        return value.value
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    return value


def _assessment_snapshot(row: PropertyTaxAssessment) -> dict[str, Any]:
    return {field: _json_value(getattr(row, field)) for field in ASSESSMENT_REVISION_FIELDS}


def _diff_snapshots(previous: dict[str, Any] | None, current: dict[str, Any]) -> dict[str, Any]:
    if previous is None:
        return {key: {"before": None, "after": value} for key, value in current.items() if value not in (None, "", [], {})}
    changed: dict[str, Any] = {}
    for key, after in current.items():
        before = previous.get(key)
        if before != after:
            changed[key] = {"before": before, "after": after}
    return changed


async def _write_revision(
    db: AsyncSession,
    assessment: PropertyTaxAssessment,
    changed_by_id: uuid.UUID | None,
    previous_snapshot: dict[str, Any] | None,
    reason: str | None = None,
) -> None:
    current = _assessment_snapshot(assessment)
    db.add(PropertyTaxAssessmentRevision(
        assessment_id=assessment.id,
        feature_id=assessment.feature_id,
        dataset_id=assessment.dataset_id,
        changed_by_id=changed_by_id,
        version=assessment.version,
        status=str(_json_value(assessment.status)),
        change_reason=_clean_text(reason) or _clean_text(assessment.remarks),
        changed_fields=_diff_snapshots(previous_snapshot, current),
        snapshot=current,
    ))


def _validate_assessment_for_status(body: PropertyTaxAssessmentUpsert, calculated_total: float | None) -> None:
    if body.status == "demand_generated":
        raise HTTPException(status_code=409, detail="Demand Generated status can only be set by generating an annual demand")
    if body.status != "approved":
        return
    missing: list[str] = []
    if not (body.property_id or body.assessment_number):
        missing.append("Property ID or Assessment Number")
    if not body.municipal_use:
        missing.append("Property Use")
    if body.municipal_built_up_area_sqm is None and not body.floor_assessments:
        missing.append("Taxable Built-up Area or Floor-wise Areas")
    if calculated_total is None:
        missing.append("Complete Tax Calculation")
    if missing:
        raise HTTPException(status_code=422, detail="Approved assessment requires: " + ", ".join(missing))

def _canonical_columns(columns: list[Any]) -> dict[str, str]:
    normalized = {_normalize_key(column): str(column) for column in columns}
    result: dict[str, str] = {}
    for target, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            source = normalized.get(_normalize_key(alias))
            if source:
                result[target] = source
                break
    return result


def _feature_identifier_values(feature: Feature) -> dict[str, set[str]]:
    attributes = feature.attributes or {}
    normalized = {_normalize_key(key): value for key, value in attributes.items()}
    values: dict[str, set[str]] = defaultdict(set)
    for group, aliases in IDENTIFIER_ALIASES.items():
        for alias in aliases:
            raw = normalized.get(_normalize_key(alias))
            cleaned = _clean_text(raw)
            if cleaned:
                values[group].add(_normalize_key(cleaned))
    label = _clean_text(feature.label)
    if label:
        values["label"].add(_normalize_key(label))
    return values


def _calculate(body: PropertyTaxAssessmentUpsert) -> tuple[float | None, float | None, dict[str, Any]]:
    floor_lines: list[dict[str, Any]] = []
    floor_base = 0.0
    valid_floor = False
    for line in body.floor_assessments:
        rate = line.annual_rate_per_sqm if line.annual_rate_per_sqm is not None else body.annual_rate_per_sqm
        if line.area_sqm <= 0 or rate is None:
            continue
        subtotal = line.area_sqm * rate * line.usage_factor
        floor_base += subtotal
        valid_floor = True
        floor_lines.append({**line.model_dump(), "subtotal": round(subtotal, 2)})

    if valid_floor:
        area_rate_base = floor_base
        calculation_mode = "floor_wise"
    elif body.municipal_built_up_area_sqm is not None and body.annual_rate_per_sqm is not None:
        area_rate_base = body.municipal_built_up_area_sqm * body.annual_rate_per_sqm * body.usage_factor
        calculation_mode = "whole_building"
    else:
        return None, None, {"mode": "incomplete", "floor_lines": floor_lines}

    base_tax = area_rate_base * body.zone_factor * body.construction_factor * body.age_factor
    cess_amount = base_tax * body.cess_percent / 100
    total = max(0.0, base_tax + cess_amount + body.service_charge - body.rebate_amount - body.exemption_amount)
    breakdown = {
        "mode": calculation_mode,
        "area_rate_base": round(area_rate_base, 2),
        "zone_factor": body.zone_factor,
        "construction_factor": body.construction_factor,
        "age_factor": body.age_factor,
        "base_tax": round(base_tax, 2),
        "cess_percent": body.cess_percent,
        "cess_amount": round(cess_amount, 2),
        "service_charge": body.service_charge,
        "rebate_amount": body.rebate_amount,
        "exemption_amount": body.exemption_amount,
        "floor_lines": floor_lines,
        "total": round(total, 2),
    }
    return round(base_tax, 2), round(total, 2), breakdown


def _copy_record_values(row: PropertyTaxMunicipalRecord) -> dict[str, Any]:
    return {
        "property_id": row.property_id,
        "assessment_number": row.assessment_number,
        "owner_name": row.owner_name,
        "occupancy_status": row.occupancy_status,
        "construction_type": row.construction_type,
        "tax_zone": row.tax_zone,
        "municipal_use": row.municipal_use,
        "municipal_plot_area_sqm": row.municipal_plot_area_sqm,
        "municipal_built_up_area_sqm": row.municipal_built_up_area_sqm,
        "municipal_floor_count": row.municipal_floor_count,
        "annual_rate_per_sqm": row.annual_rate_per_sqm,
        "financial_year": row.financial_year or "2026-27",
        "municipal_record_id": row.id,
    }


@router.get("/assessments/{feature_id}", response_model=PropertyTaxAssessmentOut | None)
async def get_assessment(
    feature_id: uuid.UUID,
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PropertyTaxAssessmentOut | None:
    row = await db.scalar(select(PropertyTaxAssessment).where(PropertyTaxAssessment.feature_id == feature_id))
    return PropertyTaxAssessmentOut.model_validate(row) if row else None


@router.get("/assessments/{feature_id}/history", response_model=list[PropertyTaxAssessmentRevisionOut])
async def get_assessment_history(
    feature_id: uuid.UUID,
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PropertyTaxAssessmentRevisionOut]:
    rows = (await db.scalars(
        select(PropertyTaxAssessmentRevision)
        .where(PropertyTaxAssessmentRevision.feature_id == feature_id)
        .order_by(PropertyTaxAssessmentRevision.version.desc())
        .limit(100)
    )).all()
    return [PropertyTaxAssessmentRevisionOut.model_validate(row) for row in rows]


@router.get("/survey-enrichment/{feature_id}")
async def get_survey_enrichment(
    feature_id: uuid.UUID,
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return surveyed plot/parcel attributes containing the selected building."""
    building = await db.scalar(select(Feature).where(Feature.id == feature_id))
    if building is None:
        raise HTTPException(status_code=404, detail="GIS feature not found")

    result = await db.execute(
        text(
            """
            SELECT
                p.id::text AS plot_feature_id,
                p.attributes AS plot_attributes,
                ST_Area(p.geom::geography) AS plot_geometry_area_sqm
            FROM features AS b
            JOIN features AS p
              ON p.dataset_id = b.dataset_id
             AND p.id <> b.id
            WHERE b.id = :feature_id
              AND GeometryType(p.geom) IN ('POLYGON', 'MULTIPOLYGON')
              AND ST_Intersects(p.geom, ST_PointOnSurface(b.geom))
              AND (
                    lower(coalesce(p.category, '')) ~ '(plot|parcel|property)'
                 OR lower(coalesce(p.attributes->>'Layer', '')) ~ '(plot|parcel|property)'
                 OR p.attributes ? 'Plot'
                 OR p.attributes ? 'Plot_ID'
                 OR p.attributes ? 'Existing_PID'
                 OR p.attributes ? 'Extent_of_the_Plot_as_per_survey'
              )
            ORDER BY
                CASE WHEN ST_Covers(p.geom, ST_PointOnSurface(b.geom)) THEN 0 ELSE 1 END,
                ST_Area(ST_Intersection(p.geom, b.geom)::geography) DESC
            LIMIT 1
            """
        ),
        {"feature_id": str(feature_id)},
    )
    row = result.mappings().first()
    if row is None:
        return {
            "building_feature_id": str(feature_id),
            "plot_feature_id": None,
            "plot_attributes": {},
            "plot_geometry_area_sqm": None,
        }
    return {
        "building_feature_id": str(feature_id),
        "plot_feature_id": row["plot_feature_id"],
        "plot_attributes": row["plot_attributes"] or {},
        "plot_geometry_area_sqm": round(float(row["plot_geometry_area_sqm"]), 2)
        if row["plot_geometry_area_sqm"] is not None else None,
    }


@router.put("/assessments/{feature_id}", response_model=PropertyTaxAssessmentOut)
async def upsert_assessment(
    feature_id: uuid.UUID,
    body: PropertyTaxAssessmentUpsert,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PropertyTaxAssessmentOut:
    feature = await db.scalar(select(Feature).where(Feature.id == feature_id))
    if feature is None:
        raise HTTPException(status_code=404, detail="GIS feature not found")

    municipal = None
    if body.municipal_record_id is not None:
        municipal = await db.scalar(
            select(PropertyTaxMunicipalRecord).where(PropertyTaxMunicipalRecord.id == body.municipal_record_id)
        )
        if municipal is None:
            raise HTTPException(status_code=422, detail="Linked municipal record does not exist")
        if municipal.feature_id != feature_id:
            raise HTTPException(status_code=409, detail="Municipal record must be linked to this GIS building first")

    base_tax, total_tax, _breakdown = _calculate(body)
    _validate_assessment_for_status(body, total_tax)
    values = body.model_dump(mode="json")
    values["base_annual_tax"] = base_tax
    values["estimated_annual_tax"] = total_tax

    row = await db.scalar(select(PropertyTaxAssessment).where(PropertyTaxAssessment.feature_id == feature_id))
    previous_snapshot: dict[str, Any] | None = None
    if row is None:
        row = PropertyTaxAssessment(
            feature_id=feature.id,
            dataset_id=feature.dataset_id,
            created_by_id=current_user.id,
            updated_by_id=current_user.id,
            **values,
        )
        db.add(row)
        await db.flush()
    else:
        if row.status == "demand_generated":
            raise HTTPException(status_code=409, detail="Generated demand locks this assessment. Cancel the demand before editing it")
        previous_snapshot = _assessment_snapshot(row)
        for key, value in values.items():
            setattr(row, key, value)
        row.dataset_id = feature.dataset_id
        row.updated_by_id = current_user.id
        row.version += 1
        await db.flush()

    await _write_revision(db, row, current_user.id, previous_snapshot, body.remarks)
    await db.flush()
    await db.refresh(row)
    return PropertyTaxAssessmentOut.model_validate(row)


@router.delete("/assessments/{feature_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_assessment(
    feature_id: uuid.UUID,
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    row = await db.scalar(select(PropertyTaxAssessment).where(PropertyTaxAssessment.feature_id == feature_id))
    if row is None:
        raise HTTPException(status_code=404, detail="Property-tax assessment not found")
    demand = await db.scalar(select(PropertyTaxDemand.id).where(PropertyTaxDemand.assessment_id == row.id))
    if demand:
        raise HTTPException(status_code=409, detail="Assessment has a generated demand and cannot be deleted")
    await db.delete(row)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/municipal-records/import", response_model=MunicipalRecordImportResponse)
async def import_municipal_records(
    dataset_id: uuid.UUID = Form(...),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MunicipalRecordImportResponse:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".csv", ".xlsx", ".xls"}:
        raise HTTPException(status_code=415, detail="Upload a CSV, XLSX or XLS municipal register")
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Municipal register exceeds the 50 MB limit")
    try:
        dataframe = pd.read_csv(io.BytesIO(content), dtype=object) if suffix == ".csv" else pd.read_excel(io.BytesIO(content), dtype=object)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Could not read municipal register: {exc}") from exc
    if dataframe.empty:
        raise HTTPException(status_code=422, detail="The municipal register is empty")

    mapping = _canonical_columns(list(dataframe.columns))
    has_identifier = any(key in mapping for key in ("gis_feature_id", "property_id", "assessment_number", "sas_number", "door_number"))
    has_coordinates = "source_latitude" in mapping and "source_longitude" in mapping
    if not has_identifier and not has_coordinates:
        raise HTTPException(
            status_code=422,
            detail="No GIS Feature ID, Property ID, Assessment Number, SAS Number, Door Number, or Latitude/Longitude columns were found",
        )

    features = (await db.scalars(select(Feature).where(Feature.dataset_id == dataset_id))).all()
    feature_by_id = {feature.id: feature for feature in features}
    building_features = [feature for feature in features if _looks_like_building(feature)]
    identifier_index: dict[tuple[str, str], list[uuid.UUID]] = defaultdict(list)
    for feature in building_features:
        for group, identifier_values in _feature_identifier_values(feature).items():
            for identifier_value in identifier_values:
                identifier_index[(group, identifier_value)].append(feature.id)

    centroid_rows = (await db.execute(
        select(
            Feature.id,
            func.ST_Y(func.ST_Centroid(Feature.geom)).label("latitude"),
            func.ST_X(func.ST_Centroid(Feature.geom)).label("longitude"),
        ).where(Feature.dataset_id == dataset_id)
    )).all()
    building_ids = {feature.id for feature in building_features}
    building_centroids = [
        (feature_id, float(latitude), float(longitude))
        for feature_id, latitude, longitude in centroid_rows
        if feature_id in building_ids and latitude is not None and longitude is not None
    ]

    existing_rows = (await db.scalars(
        select(PropertyTaxMunicipalRecord).where(PropertyTaxMunicipalRecord.dataset_id == dataset_id)
    )).all()
    existing_strong: dict[str, set[str]] = {
        group: {_normalize_key(getattr(row, group)) for row in existing_rows if _normalize_key(getattr(row, group))}
        for group in ("property_id", "assessment_number", "sas_number")
    }
    existing_door_owner = {
        (_normalize_key(row.door_number), _normalize_key(row.owner_name))
        for row in existing_rows if _normalize_key(row.door_number)
    }
    used_features = {row.feature_id for row in existing_rows if row.feature_id is not None}

    imported = linked = exact_linked = spatial_linked = skipped = 0
    errors: list[str] = []
    for zero_index, (_, series) in enumerate(dataframe.iterrows()):
        values: dict[str, Any] = {}
        for target, source in mapping.items():
            raw = series.get(source)
            if target in {"source_latitude", "source_longitude"}:
                values[target] = _signed_number(raw)
            elif target in {"municipal_plot_area_sqm", "municipal_built_up_area_sqm", "annual_rate_per_sqm"}:
                values[target] = _number(raw)
            elif target == "municipal_floor_count":
                values[target] = _integer(raw)
            else:
                values[target] = _clean_text(raw)

        values["municipal_use"] = _canonical_property_use(values.get("municipal_use"))
        values["occupancy_status"] = _canonical_occupancy(values.get("occupancy_status"))
        values["construction_type"] = _canonical_construction(values.get("construction_type"))
        direct_feature_id = values.pop("gis_feature_id", None)
        identifiers = {group: _normalize_key(values.get(group)) for group in ("property_id", "assessment_number", "sas_number", "door_number")}
        latitude = values.get("source_latitude")
        longitude = values.get("source_longitude")
        if latitude is not None and not (-90 <= latitude <= 90):
            latitude = values["source_latitude"] = None
        if longitude is not None and not (-180 <= longitude <= 180):
            longitude = values["source_longitude"] = None

        duplicate = any(
            identifiers[group] and identifiers[group] in existing_strong[group]
            for group in ("property_id", "assessment_number", "sas_number")
        )
        if not duplicate and identifiers["door_number"]:
            duplicate = (identifiers["door_number"], _normalize_key(values.get("owner_name"))) in existing_door_owner
        if duplicate:
            skipped += 1
            continue
        if not any(identifiers.values()) and not direct_feature_id and not (latitude is not None and longitude is not None):
            skipped += 1
            if len(errors) < 20:
                errors.append(f"Row {zero_index + 2}: no usable identifier or coordinates")
            continue

        feature_id: uuid.UUID | None = None
        match_method: str | None = None
        match_confidence: float | None = None

        if direct_feature_id:
            try:
                parsed_feature_id = uuid.UUID(str(direct_feature_id))
            except (TypeError, ValueError, AttributeError):
                parsed_feature_id = None
            if parsed_feature_id in feature_by_id and parsed_feature_id in building_ids and parsed_feature_id not in used_features:
                feature_id = parsed_feature_id
                match_method = "exact:gis_feature_id"
                match_confidence = 1.0

        if feature_id is None:
            candidates: set[uuid.UUID] = set()
            matched_groups: list[str] = []
            for group in ("property_id", "assessment_number", "sas_number", "door_number"):
                normalized_value = identifiers[group]
                if not normalized_value:
                    continue
                matches = [candidate for candidate in identifier_index.get((group, normalized_value), []) if candidate not in used_features]
                if matches:
                    matched_groups.append(group)
                    candidates.update(matches)
            if len(candidates) == 1:
                feature_id = next(iter(candidates))
                match_method = "exact:" + "+".join(matched_groups)
                match_confidence = 1.0

        if feature_id is None and latitude is not None and longitude is not None:
            nearest_id: uuid.UUID | None = None
            nearest_distance = float("inf")
            for candidate_id, candidate_latitude, candidate_longitude in building_centroids:
                if candidate_id in used_features:
                    continue
                distance = _haversine_metres(latitude, longitude, candidate_latitude, candidate_longitude)
                if distance < nearest_distance:
                    nearest_id = candidate_id
                    nearest_distance = distance
            if nearest_id is not None and nearest_distance <= 35:
                feature_id = nearest_id
                match_method = "spatial:centroid"
                match_confidence = round(max(0.55, 1 - nearest_distance / 70), 3)

        if feature_id is not None:
            used_features.add(feature_id)

        raw_record = {str(column): _clean_text(series.get(column)) for column in dataframe.columns}
        row = PropertyTaxMunicipalRecord(
            dataset_id=dataset_id,
            feature_id=feature_id,
            imported_by_id=current_user.id,
            linked_by_id=current_user.id if feature_id else None,
            source_name=file.filename or "municipal-register",
            source_row_number=zero_index + 2,
            match_method=match_method,
            match_confidence=match_confidence,
            linked_at=datetime.now(UTC) if feature_id else None,
            raw_record=raw_record,
            **values,
        )
        db.add(row)
        for group in ("property_id", "assessment_number", "sas_number"):
            if identifiers[group]:
                existing_strong[group].add(identifiers[group])
        if identifiers["door_number"]:
            existing_door_owner.add((identifiers["door_number"], _normalize_key(values.get("owner_name"))))
        imported += 1
        if feature_id is not None:
            linked += 1
            if match_method == "spatial:centroid":
                spatial_linked += 1
            else:
                exact_linked += 1

    await db.flush()
    return MunicipalRecordImportResponse(
        source_name=file.filename or "municipal-register",
        imported=imported,
        linked=linked,
        exact_linked=exact_linked,
        spatial_linked=spatial_linked,
        unlinked=imported - linked,
        skipped=skipped,
        errors=errors,
    )


@router.get("/municipal-records/linked/{feature_id}", response_model=MunicipalPropertyRecordOut | None)
async def get_linked_municipal_record(
    feature_id: uuid.UUID,
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MunicipalPropertyRecordOut | None:
    row = await db.scalar(select(PropertyTaxMunicipalRecord).where(PropertyTaxMunicipalRecord.feature_id == feature_id))
    return MunicipalPropertyRecordOut.model_validate(row) if row else None


@router.get("/municipal-records/suggestions/{feature_id}", response_model=MunicipalRecordSearchResponse)
async def suggest_municipal_records(
    feature_id: uuid.UUID,
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MunicipalRecordSearchResponse:
    feature = await db.scalar(select(Feature).where(Feature.id == feature_id))
    if feature is None:
        raise HTTPException(status_code=404, detail="GIS feature not found")
    identifiers = _feature_identifier_values(feature)
    conditions = []
    for group in ("property_id", "assessment_number", "sas_number", "door_number"):
        for normalized_value in identifiers.get(group, set()):
            column = getattr(PropertyTaxMunicipalRecord, group)
            normalized_column = func.regexp_replace(func.lower(column), "[^a-z0-9]", "", "g")
            conditions.append(normalized_column == normalized_value)
    candidates = []
    if conditions:
        candidates = (await db.scalars(
            select(PropertyTaxMunicipalRecord)
            .where(PropertyTaxMunicipalRecord.dataset_id == feature.dataset_id)
            .where(PropertyTaxMunicipalRecord.feature_id.is_(None))
            .where(or_(*conditions))
            .limit(25)
        )).all()
    exact = []
    for row in candidates:
        for group in ("property_id", "assessment_number", "sas_number", "door_number"):
            if _normalize_key(getattr(row, group)) in identifiers.get(group, set()):
                exact.append(row)
                break
    return MunicipalRecordSearchResponse(records=[MunicipalPropertyRecordOut.model_validate(row) for row in exact[:10]], count=len(exact))


@router.get("/municipal-records/search", response_model=MunicipalRecordSearchResponse)
async def search_municipal_records(
    q: str = Query(default="", max_length=128),
    dataset_id: uuid.UUID | None = None,
    unlinked_only: bool = False,
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MunicipalRecordSearchResponse:
    query = select(PropertyTaxMunicipalRecord)
    filters = []
    if dataset_id is not None:
        filters.append(PropertyTaxMunicipalRecord.dataset_id == dataset_id)
    if unlinked_only:
        filters.append(PropertyTaxMunicipalRecord.feature_id.is_(None))
    cleaned = q.strip()
    if cleaned:
        like = f"%{cleaned}%"
        filters.append(or_(
            PropertyTaxMunicipalRecord.property_id.ilike(like),
            PropertyTaxMunicipalRecord.assessment_number.ilike(like),
            PropertyTaxMunicipalRecord.sas_number.ilike(like),
            PropertyTaxMunicipalRecord.door_number.ilike(like),
            PropertyTaxMunicipalRecord.owner_name.ilike(like),
            PropertyTaxMunicipalRecord.address.ilike(like),
        ))
    if filters:
        query = query.where(and_(*filters))
    rows = (await db.scalars(query.order_by(PropertyTaxMunicipalRecord.updated_at.desc()).limit(50))).all()
    return MunicipalRecordSearchResponse(records=[MunicipalPropertyRecordOut.model_validate(row) for row in rows], count=len(rows))


@router.put("/municipal-records/{record_id}/link/{feature_id}", response_model=MunicipalPropertyRecordOut)
async def link_municipal_record(
    record_id: uuid.UUID,
    feature_id: uuid.UUID,
    body: MunicipalRecordLinkRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MunicipalPropertyRecordOut:
    row = await db.scalar(select(PropertyTaxMunicipalRecord).where(PropertyTaxMunicipalRecord.id == record_id))
    feature = await db.scalar(select(Feature).where(Feature.id == feature_id))
    if row is None or feature is None:
        raise HTTPException(status_code=404, detail="Municipal record or GIS feature not found")
    if row.feature_id is not None and row.feature_id != feature_id:
        raise HTTPException(status_code=409, detail="This municipal record is already linked to another GIS building")
    occupied = await db.scalar(
        select(PropertyTaxMunicipalRecord.id).where(
            PropertyTaxMunicipalRecord.feature_id == feature_id,
            PropertyTaxMunicipalRecord.id != record_id,
        )
    )
    if occupied:
        raise HTTPException(status_code=409, detail="This GIS building is already linked to another municipal record")
    row.dataset_id = feature.dataset_id
    row.feature_id = feature_id
    row.linked_by_id = current_user.id
    row.linked_at = datetime.now(UTC)
    row.match_method = "manual"
    row.match_confidence = 1.0

    if body.copy_to_assessment:
        assessment = await db.scalar(select(PropertyTaxAssessment).where(PropertyTaxAssessment.feature_id == feature_id))
        copied = _copy_record_values(row)
        previous_snapshot: dict[str, Any] | None = None
        if assessment is None:
            assessment = PropertyTaxAssessment(
                feature_id=feature.id,
                dataset_id=feature.dataset_id,
                created_by_id=current_user.id,
                updated_by_id=current_user.id,
                status="draft",
                gis_snapshot={},
                **copied,
            )
            db.add(assessment)
            await db.flush()
        else:
            if assessment.status == "demand_generated":
                raise HTTPException(status_code=409, detail="Generated demand locks this assessment")
            previous_snapshot = _assessment_snapshot(assessment)
            for key, value in copied.items():
                if value is not None:
                    setattr(assessment, key, value)
            assessment.updated_by_id = current_user.id
            assessment.version += 1
            await db.flush()
        await _write_revision(db, assessment, current_user.id, previous_snapshot, "Municipal record linked")

    await db.flush()
    await db.refresh(row)
    return MunicipalPropertyRecordOut.model_validate(row)


@router.delete("/municipal-records/{record_id}/link", status_code=status.HTTP_204_NO_CONTENT)
async def unlink_municipal_record(
    record_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    row = await db.scalar(select(PropertyTaxMunicipalRecord).where(PropertyTaxMunicipalRecord.id == record_id))
    if row is None:
        raise HTTPException(status_code=404, detail="Municipal record not found")
    linked_feature_id = row.feature_id
    if linked_feature_id is not None:
        assessment = await db.scalar(
            select(PropertyTaxAssessment).where(PropertyTaxAssessment.feature_id == linked_feature_id)
        )
        if assessment is not None:
            if assessment.status == "demand_generated":
                raise HTTPException(status_code=409, detail="Generated demand locks the official-record link")
            previous_snapshot = _assessment_snapshot(assessment)
            assessment.municipal_record_id = None
            assessment.updated_by_id = current_user.id
            assessment.version += 1
            await db.flush()
            await _write_revision(db, assessment, current_user.id, previous_snapshot, "Municipal record unlinked")
    row.feature_id = None
    row.linked_by_id = None
    row.linked_at = None
    row.match_method = None
    row.match_confidence = None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/demands/{feature_id}", response_model=PropertyTaxDemandOut | None)
async def get_demand(
    feature_id: uuid.UUID,
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PropertyTaxDemandOut | None:
    row = await db.scalar(
        select(PropertyTaxDemand).where(PropertyTaxDemand.feature_id == feature_id).order_by(PropertyTaxDemand.created_at.desc())
    )
    return PropertyTaxDemandOut.model_validate(row) if row else None


@router.post("/assessments/{feature_id}/generate-demand", response_model=PropertyTaxDemandOut)
async def generate_demand(
    feature_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PropertyTaxDemandOut:
    assessment = await db.scalar(select(PropertyTaxAssessment).where(PropertyTaxAssessment.feature_id == feature_id))
    if assessment is None:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if assessment.status not in {"approved", "demand_generated"}:
        raise HTTPException(status_code=409, detail="Approve the assessment before generating demand")
    existing = await db.scalar(select(PropertyTaxDemand).where(
        PropertyTaxDemand.assessment_id == assessment.id,
        PropertyTaxDemand.financial_year == assessment.financial_year,
    ))
    if existing:
        return PropertyTaxDemandOut.model_validate(existing)

    body = PropertyTaxAssessmentUpsert.model_validate({
        column.name: getattr(assessment, column.name)
        for column in PropertyTaxAssessment.__table__.columns
        if column.name in PropertyTaxAssessmentUpsert.model_fields
    })
    base_tax, total, breakdown = _calculate(body)
    if total is None:
        raise HTTPException(status_code=422, detail="Tax calculation is incomplete")
    _validate_assessment_for_status(body.model_copy(update={"status": "approved"}), total)

    cess_amount = 0.0 if base_tax is None else base_tax * assessment.cess_percent / 100
    demand_number = f"PT-{assessment.financial_year.replace('-', '')}-{str(assessment.id)[:8].upper()}"
    demand = PropertyTaxDemand(
        assessment_id=assessment.id,
        feature_id=assessment.feature_id,
        dataset_id=assessment.dataset_id,
        generated_by_id=current_user.id,
        financial_year=assessment.financial_year,
        demand_number=demand_number,
        base_tax=base_tax or 0,
        cess_amount=round(cess_amount, 2),
        service_charge=assessment.service_charge,
        rebate_amount=assessment.rebate_amount,
        exemption_amount=assessment.exemption_amount,
        total_demand=total,
        calculation_breakdown=breakdown,
        generated_at=datetime.now(UTC),
    )
    db.add(demand)
    previous_snapshot = _assessment_snapshot(assessment)
    assessment.status = "demand_generated"
    assessment.version += 1
    assessment.updated_by_id = current_user.id
    await db.flush()
    await _write_revision(db, assessment, current_user.id, previous_snapshot, f"Annual demand {demand_number} generated")
    await db.flush()
    await db.refresh(demand)
    return PropertyTaxDemandOut.model_validate(demand)


"""Deterministic, evidence-backed Analytics quality analysis.

The engine scans the complete applied SQL/PostGIS scope using a streamed
query. It does not ask an LLM to calculate counts or scores. Findings are
layer/category aware and intentionally avoid unapproved engineering limits.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import math
import re
import uuid
from typing import Any, Iterable

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Feature
from app.schemas.workflow import (
    AnalyticsFinding,
    AnalyticsQualityComponent,
    AnalyticsQualityReport,
)
from app.services.analytics.scope import CATEGORY_EXPR, SeverityBucketName, feature_conditions

_INTERNAL_ATTRIBUTE_KEYS = {
    "fid",
    "gdb_layer",
    "shape_length",
    "shape_area",
    "objectid",
    "object_id",
}
_EVIDENCE_LIMIT = 100
_RELEVANT_ATTRIBUTE_MIN_RATE = 0.20
_MAX_ATTRIBUTE_FINDINGS = 12


def _is_populated(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return True



def _source_identifier(label: Any, attributes: dict[str, Any]) -> str:
    """Return the best traceable identifier without changing stored data.

    Some mixed-layer GDB imports select a sparse human-readable ``Name``
    column as ``Feature.label`` even though every source row still preserves
    its FID/OBJECTID in JSONB. Quality checks therefore prefer common source
    identifier fields and safely fall back to the stored display label.
    """
    by_casefold = {str(key).casefold(): value for key, value in attributes.items()}
    for key in ("fid", "objectid", "object_id", "id"):
        value = by_casefold.get(key)
        if _is_populated(value):
            return str(value).strip()
    if _is_populated(label):
        return str(label).strip()
    return ""

def _normalized_category(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def _score_component(passed: int, failed: int) -> float:
    total = passed + failed
    if total <= 0:
        return 100.0
    return round((passed / total) * 100.0, 1)


def _priority_score(severity: str, affected_count: int, total_features: int) -> int:
    base = {"critical": 88, "high": 68, "medium": 43, "low": 20}[severity]
    percentage = (affected_count / total_features) if total_features else 0.0
    impact = min(18.0, math.sqrt(max(0.0, percentage)) * 18.0)
    scale = min(8.0, math.log10(max(1, affected_count)) * 3.0)
    return min(100, int(round(base + impact + scale)))


def _append_evidence(store: dict[Any, list[uuid.UUID]], key: Any, feature_id: uuid.UUID) -> None:
    bucket = store[key]
    if len(bucket) < _EVIDENCE_LIMIT:
        bucket.append(feature_id)


async def build_quality_report(
    db: AsyncSession,
    *,
    dataset_ids: list[uuid.UUID],
    categories: list[str],
    wards: list[str],
    severity_buckets: list[SeverityBucketName],
) -> AnalyticsQualityReport:
    conditions = feature_conditions(dataset_ids, categories, wards, severity_buckets)

    dimension = func.ST_Dimension(Feature.geom)
    measure = case(
        (dimension == 1, func.ST_Length(Feature.geom)),
        (dimension == 2, func.ST_Area(Feature.geom)),
        else_=1.0,
    )
    stmt = (
        select(
            Feature.id,
            Feature.dataset_id,
            Feature.category.label("raw_category"),
            CATEGORY_EXPR.label("category"),
            Feature.label,
            Feature.attributes,
            Feature.severity,
            func.ST_IsValid(Feature.geom).label("geometry_valid"),
            func.ST_IsEmpty(Feature.geom).label("geometry_empty"),
            dimension.label("geometry_dimension"),
            measure.label("geometry_measure"),
            func.md5(func.ST_AsEWKT(Feature.geom)).label("geometry_hash"),
        )
        .where(*conditions)
        .order_by(Feature.id)
        .execution_options(yield_per=1000)
    )

    total = 0
    valid_geometry = 0
    invalid_or_empty_ids: list[uuid.UUID] = []
    degenerate_ids: list[uuid.UUID] = []
    missing_category_ids: list[uuid.UUID] = []
    missing_identifier_ids: list[uuid.UUID] = []
    high_severity_ids: list[uuid.UUID] = []
    high_severity_count = 0
    degenerate_count = 0
    missing_category_count = 0
    missing_identifier_count = 0

    geometry_hash_counts: Counter[tuple[uuid.UUID, str, str]] = Counter()
    geometry_hash_ids: dict[tuple[uuid.UUID, str, str], list[uuid.UUID]] = defaultdict(list)
    identifier_counts: Counter[tuple[uuid.UUID, str, str]] = Counter()
    identifier_ids: dict[tuple[uuid.UUID, str, str], list[uuid.UUID]] = defaultdict(list)
    category_variants: dict[str, Counter[str]] = defaultdict(Counter)
    category_variant_ids: dict[str, list[uuid.UUID]] = defaultdict(list)

    category_total: Counter[str] = Counter()
    populated: Counter[tuple[str, str]] = Counter()
    missing_attribute_ids: dict[tuple[str, str], list[uuid.UUID]] = defaultdict(list)
    attribute_keys_by_category: dict[str, set[str]] = defaultdict(set)

    result = await db.stream(stmt)
    async for row in result:
        total += 1
        feature_id: uuid.UUID = row.id
        dataset_id: uuid.UUID = row.dataset_id
        category = str(row.category or "uncategorized")
        raw_category = row.raw_category
        category_total[category] += 1

        geometry_valid = bool(row.geometry_valid)
        geometry_empty = bool(row.geometry_empty)
        if geometry_valid and not geometry_empty:
            valid_geometry += 1
        elif len(invalid_or_empty_ids) < _EVIDENCE_LIMIT:
            invalid_or_empty_ids.append(feature_id)
        dimension_value = int(row.geometry_dimension) if row.geometry_dimension is not None else -1
        measure_value = float(row.geometry_measure or 0.0)
        if dimension_value in (1, 2) and measure_value <= 1e-12:
            degenerate_count += 1
            if len(degenerate_ids) < _EVIDENCE_LIMIT:
                degenerate_ids.append(feature_id)

        geometry_hash = str(row.geometry_hash or "")
        if geometry_hash:
            geometry_key = (dataset_id, category, geometry_hash)
            geometry_hash_counts[geometry_key] += 1
            _append_evidence(geometry_hash_ids, geometry_key, feature_id)

        if raw_category is None or not str(raw_category).strip():
            missing_category_count += 1
            if len(missing_category_ids) < _EVIDENCE_LIMIT:
                missing_category_ids.append(feature_id)
        normalized = _normalized_category(category)
        if normalized:
            category_variants[normalized][category] += 1
            _append_evidence(category_variant_ids, normalized, feature_id)

        attributes = row.attributes if isinstance(row.attributes, dict) else {}
        identifier = _source_identifier(row.label, attributes)
        if not identifier:
            missing_identifier_count += 1
            if len(missing_identifier_ids) < _EVIDENCE_LIMIT:
                missing_identifier_ids.append(feature_id)
        else:
            identifier_key = (dataset_id, category, identifier.casefold())
            identifier_counts[identifier_key] += 1
            _append_evidence(identifier_ids, identifier_key, feature_id)

        if float(row.severity or 0.0) >= 0.67:
            high_severity_count += 1
            if len(high_severity_ids) < _EVIDENCE_LIMIT:
                high_severity_ids.append(feature_id)

        for key, value in attributes.items():
            normalized_key = str(key).strip()
            if not normalized_key or normalized_key.casefold() in _INTERNAL_ATTRIBUTE_KEYS:
                continue
            attribute_keys_by_category[category].add(normalized_key)
            pair = (category, normalized_key)
            if _is_populated(value):
                populated[pair] += 1
            else:
                _append_evidence(missing_attribute_ids, pair, feature_id)

    if total == 0:
        return AnalyticsQualityReport(
            total_features=0,
            overall_score=None,
            components=[],
            findings=[],
            methodology=(
                "No matching features were available. No score or finding was generated."
            ),
            generated_at=datetime.now(timezone.utc),
        )

    duplicate_geometry_extras = 0
    duplicate_geometry_ids: list[uuid.UUID] = []
    for key, count in geometry_hash_counts.items():
        if count > 1:
            duplicate_geometry_extras += count - 1
            for feature_id in geometry_hash_ids[key]:
                if len(duplicate_geometry_ids) < _EVIDENCE_LIMIT:
                    duplicate_geometry_ids.append(feature_id)

    duplicate_identifier_extras = 0
    duplicate_identifier_ids: list[uuid.UUID] = []
    for key, count in identifier_counts.items():
        if count > 1:
            duplicate_identifier_extras += count - 1
            for feature_id in identifier_ids[key]:
                if len(duplicate_identifier_ids) < _EVIDENCE_LIMIT:
                    duplicate_identifier_ids.append(feature_id)

    variant_group_count = 0
    variant_feature_count = 0
    variant_ids: list[uuid.UUID] = []
    variant_descriptions: list[str] = []
    for normalized, variants in category_variants.items():
        if len(variants) <= 1:
            continue
        variant_group_count += 1
        variant_feature_count += sum(variants.values())
        variant_descriptions.append(", ".join(sorted(variants)))
        for feature_id in category_variant_ids[normalized]:
            if len(variant_ids) < _EVIDENCE_LIMIT:
                variant_ids.append(feature_id)

    relevant_attribute_pairs: list[tuple[str, str, int, int]] = []
    for category, keys in attribute_keys_by_category.items():
        category_count = category_total[category]
        minimum_populated = max(2, math.ceil(category_count * _RELEVANT_ATTRIBUTE_MIN_RATE))
        for key in keys:
            populated_count = populated[(category, key)]
            if populated_count >= minimum_populated:
                relevant_attribute_pairs.append((category, key, populated_count, category_count))

    attribute_passed = sum(item[2] for item in relevant_attribute_pairs)
    attribute_expected = sum(item[3] for item in relevant_attribute_pairs)
    attribute_failed = max(0, attribute_expected - attribute_passed)

    components = [
        AnalyticsQualityComponent(
            key="geometry_validity",
            label="Geometry validity",
            score=_score_component(valid_geometry, total - valid_geometry),
            weight=35,
            passed=valid_geometry,
            failed=total - valid_geometry,
            explanation="PostGIS ST_IsValid and ST_IsEmpty checks across the complete applied scope.",
        ),
        AnalyticsQualityComponent(
            key="category_completeness",
            label="Category completeness",
            score=_score_component(total - missing_category_count, missing_category_count),
            weight=15,
            passed=total - missing_category_count,
            failed=missing_category_count,
            explanation="Features must have a non-blank analytical category.",
        ),
        AnalyticsQualityComponent(
            key="identifier_integrity",
            label="Identifier integrity",
            score=_score_component(
                max(0, total - missing_identifier_count - duplicate_identifier_extras),
                missing_identifier_count + duplicate_identifier_extras,
            ),
            weight=15,
            passed=max(0, total - missing_identifier_count - duplicate_identifier_extras),
            failed=missing_identifier_count + duplicate_identifier_extras,
            explanation=(
                "Source FID/OBJECTID/ID fields are checked first, with a safe fallback to stored labels; "
                "uniqueness is evaluated within dataset and category."
            ),
        ),
        AnalyticsQualityComponent(
            key="attribute_completeness",
            label="Attribute completeness",
            score=_score_component(attribute_passed, attribute_failed),
            weight=25,
            passed=attribute_passed,
            failed=attribute_failed,
            explanation=(
                "Layer-aware completeness across fields populated for at least 20% of a category; "
                "internal FID/geometry metadata is excluded."
            ),
        ),
        AnalyticsQualityComponent(
            key="duplicate_geometry",
            label="Duplicate geometry integrity",
            score=_score_component(total - duplicate_geometry_extras, duplicate_geometry_extras),
            weight=10,
            passed=total - duplicate_geometry_extras,
            failed=duplicate_geometry_extras,
            explanation="Exact duplicate geometries are compared within each dataset and category.",
        ),
    ]
    overall_score = round(
        sum(component.score * component.weight for component in components) / 100.0,
        1,
    )

    findings: list[AnalyticsFinding] = []

    def add_finding(
        *,
        finding_id: str,
        title: str,
        description: str,
        rule: str,
        severity: str,
        finding_type: str,
        affected_count: int,
        feature_ids: Iterable[uuid.UUID],
        category: str | None = None,
        attribute: str | None = None,
    ) -> None:
        if affected_count <= 0:
            return
        findings.append(
            AnalyticsFinding(
                id=finding_id,
                title=title,
                description=description,
                rule=rule,
                severity=severity,  # type: ignore[arg-type]
                finding_type=finding_type,  # type: ignore[arg-type]
                affected_count=affected_count,
                affected_percentage=round((affected_count / total) * 100.0, 2),
                priority_score=_priority_score(severity, affected_count, total),
                feature_ids=list(feature_ids)[:_EVIDENCE_LIMIT],
                category=category,
                attribute=attribute,
            )
        )

    add_finding(
        finding_id="invalid-geometry",
        title="Invalid or unusable geometry",
        description="Features failed PostGIS validity checks or contain empty geometry.",
        rule="ST_IsValid(geom) = false OR ST_IsEmpty(geom) = true",
        severity="critical",
        finding_type="geometry",
        affected_count=(total - valid_geometry),
        feature_ids=invalid_or_empty_ids,
    )
    add_finding(
        finding_id="degenerate-geometry",
        title="Zero-size line or polygon geometry",
        description="Line or polygon geometry has effectively zero stored length or area.",
        rule="ST_Dimension in (1,2) and stored geometry measure <= 1e-12",
        severity="high",
        finding_type="geometry",
        affected_count=degenerate_count,
        feature_ids=degenerate_ids,
    )
    add_finding(
        finding_id="duplicate-geometry",
        title="Exact duplicate geometry",
        description="More than one feature in the same dataset and category has identical geometry.",
        rule="Exact ST_AsEWKT geometry hash repeated within a dataset and category",
        severity="medium",
        finding_type="geometry",
        affected_count=duplicate_geometry_extras,
        feature_ids=duplicate_geometry_ids,
    )
    add_finding(
        finding_id="missing-category",
        title="Missing analytical category",
        description="Features have a blank or null category and are grouped as uncategorized.",
        rule="category IS NULL OR BTRIM(category) = ''",
        severity="high",
        finding_type="attribute",
        affected_count=missing_category_count,
        feature_ids=missing_category_ids,
    )
    add_finding(
        finding_id="missing-identifier",
        title="Missing feature identifier",
        description="Features have neither a source FID/OBJECTID/ID value nor a usable stored label.",
        rule="no populated FID/OBJECTID/OBJECT_ID/ID exists in attributes and label is blank",
        severity="medium",
        finding_type="attribute",
        affected_count=missing_identifier_count,
        feature_ids=missing_identifier_ids,
    )
    add_finding(
        finding_id="duplicate-identifier",
        title="Duplicate feature identifier",
        description="The same identifier appears more than once inside a dataset and category.",
        rule="dataset_id + category + case-insensitive label must be unique",
        severity="medium",
        finding_type="attribute",
        affected_count=duplicate_identifier_extras,
        feature_ids=duplicate_identifier_ids,
    )
    add_finding(
        finding_id="category-name-variants",
        title="Category naming variants",
        description=(
            "Multiple category spellings normalize to the same key: "
            + "; ".join(variant_descriptions[:5])
        ),
        rule="Lowercase category after removing spaces and punctuation; flag multiple variants",
        severity="low",
        finding_type="consistency",
        affected_count=variant_feature_count,
        feature_ids=variant_ids,
    )

    missing_attribute_candidates: list[tuple[int, str, str, int, int]] = []
    for category, key, populated_count, category_count in relevant_attribute_pairs:
        missing_count = category_count - populated_count
        if missing_count <= 0:
            continue
        missing_attribute_candidates.append(
            (missing_count, category, key, populated_count, category_count)
        )
    missing_attribute_candidates.sort(key=lambda item: (-item[0], item[1].casefold(), item[2].casefold()))

    for missing_count, category, key, populated_count, category_count in missing_attribute_candidates[:_MAX_ATTRIBUTE_FINDINGS]:
        completion = populated_count / category_count if category_count else 1.0
        severity = "high" if completion < 0.50 else "medium" if completion < 0.75 else "low"
        add_finding(
            finding_id=f"missing-attribute:{category}:{key}",
            title=f"Incomplete {key}",
            description=(
                f"{missing_count} of {category_count} {category} features have no usable value for {key}."
            ),
            rule=(
                f"{key} is considered relevant because at least "
                f"{int(_RELEVANT_ATTRIBUTE_MIN_RATE * 100)}% of {category} features populate it"
            ),
            severity=severity,
            finding_type="attribute",
            affected_count=missing_count,
            feature_ids=missing_attribute_ids[(category, key)],
            category=category,
            attribute=key,
        )

    add_finding(
        finding_id="high-severity-features",
        title="Features in the high-severity bucket",
        description="Features are in the system's existing high-severity bucket and should be reviewed first.",
        rule="severity >= 0.67",
        severity="high",
        finding_type="operational",
        affected_count=high_severity_count,
        feature_ids=high_severity_ids,
    )

    findings.sort(key=lambda item: (-item.priority_score, -item.affected_count, item.title.casefold()))

    return AnalyticsQualityReport(
        total_features=total,
        overall_score=overall_score,
        components=components,
        findings=findings,
        methodology=(
            "All scores and counts are deterministic SQL/PostGIS and attribute checks over the complete "
            "applied scope. No unapproved engineering threshold is used. Attribute completeness is "
            "category-aware and only evaluates fields populated for at least 20% of that category."
        ),
        generated_at=datetime.now(timezone.utc),
    )

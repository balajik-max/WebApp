"""Read-only export builders for the currently applied Analytics scope.

The export service uses the same scope predicates as the dashboard, quality
panel, map, feature table, and AI summary. It does not mutate source data.
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime, timezone
from html import escape
from io import BytesIO, StringIO
import json
from typing import Literal
import uuid

from fastapi import HTTPException
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Dataset, Feature
from app.schemas.workflow import AnalyticsQualityReport
from app.services.analytics.quality import build_quality_report
from app.services.analytics.readiness import get_readiness_field
from app.services.analytics.scope import CATEGORY_EXPR, SeverityBucketName, feature_conditions

AnalyticsExportFormat = Literal["csv", "xlsx", "pdf", "geojson"]

# Keep synchronous in-memory document generation bounded. Users can narrow the
# applied scope and retry when a dataset is larger than this safety limit.
_MAX_DETAIL_ROWS = 50_000
_EXCEL_CELL_LIMIT = 32_700


@dataclass(slots=True)
class ExportRow:
    feature_id: uuid.UUID
    dataset_id: uuid.UUID
    dataset_name: str
    ward: str | None
    label: str | None
    category: str
    severity: float
    geometry_type: str
    created_at: datetime
    attributes: dict
    wkt: str
    geojson_geometry: str


@dataclass(slots=True)
class ExportSummary:
    generated_at: datetime
    dataset_names: list[str]
    wards: list[str]
    requested_categories: list[str]
    requested_severity_buckets: list[str]
    requested_missing_field: str | None
    total_features: int
    average_severity: float
    severity_counts: dict[str, int]
    category_counts: list[tuple[str, int]]


def _severity_bucket(value: float) -> str:
    if value < 0.34:
        return "low"
    if value < 0.67:
        return "medium"
    return "high"


def _safe_excel_text(value: object) -> str:
    text = "" if value is None else str(value)
    if len(text) <= _EXCEL_CELL_LIMIT:
        return text
    return text[: _EXCEL_CELL_LIMIT - 18] + "... [truncated]"


def _scope_text(summary: ExportSummary) -> list[tuple[str, str]]:
    return [
        ("Datasets", ", ".join(summary.dataset_names) or "All datasets"),
        ("Categories", ", ".join(summary.requested_categories) or "All categories"),
        ("Wards", ", ".join(summary.wards) or "All wards"),
        (
            "Severity",
            ", ".join(summary.requested_severity_buckets) or "All severity buckets",
        ),
        (
            "Manhole readiness filter",
            (
                get_readiness_field(summary.requested_missing_field).label
                if summary.requested_missing_field
                else "None"
            ),
        ),
    ]


async def _build_summary(
    db: AsyncSession,
    *,
    dataset_ids: list[uuid.UUID],
    categories: list[str],
    wards: list[str],
    severity_buckets: list[SeverityBucketName],
    missing_field: str | None,
) -> ExportSummary:
    conditions = feature_conditions(
        dataset_ids, categories, wards, severity_buckets, missing_field
    )

    stats = (
        await db.execute(
            select(
                func.count(Feature.id).label("total"),
                func.avg(Feature.severity).label("average_severity"),
            ).where(*conditions)
        )
    ).one()
    total = int(stats.total or 0)
    average_severity = round(float(stats.average_severity or 0.0), 3)

    dataset_rows = (
        await db.execute(
            select(Dataset.name, Dataset.ward)
            .join(Feature, Feature.dataset_id == Dataset.id)
            .where(*conditions)
            .distinct()
            .order_by(Dataset.name)
        )
    ).all()
    dataset_names = sorted({str(row.name) for row in dataset_rows})
    actual_wards = sorted({str(row.ward) for row in dataset_rows if row.ward})

    severity_expr = case(
        (Feature.severity < 0.34, "low"),
        (Feature.severity < 0.67, "medium"),
        else_="high",
    )
    severity_rows = (
        await db.execute(
            select(severity_expr.label("bucket"), func.count(Feature.id).label("count"))
            .where(*conditions)
            .group_by(severity_expr)
        )
    ).all()
    severity_counts = {"low": 0, "medium": 0, "high": 0}
    for row in severity_rows:
        severity_counts[str(row.bucket)] = int(row.count or 0)

    category_rows = (
        await db.execute(
            select(CATEGORY_EXPR.label("category"), func.count(Feature.id).label("count"))
            .where(*conditions)
            .group_by(CATEGORY_EXPR)
            .order_by(func.count(Feature.id).desc(), CATEGORY_EXPR.asc())
        )
    ).all()

    return ExportSummary(
        generated_at=datetime.now(timezone.utc),
        dataset_names=dataset_names,
        wards=actual_wards if not wards else wards,
        requested_categories=categories,
        requested_severity_buckets=list(severity_buckets),
        requested_missing_field=missing_field,
        total_features=total,
        average_severity=average_severity,
        severity_counts=severity_counts,
        category_counts=[(str(row.category), int(row.count or 0)) for row in category_rows],
    )


async def _load_detail_rows(
    db: AsyncSession,
    *,
    dataset_ids: list[uuid.UUID],
    categories: list[str],
    wards: list[str],
    severity_buckets: list[SeverityBucketName],
    missing_field: str | None,
    total_features: int,
) -> list[ExportRow]:
    if total_features > _MAX_DETAIL_ROWS:
        raise HTTPException(
            status_code=413,
            detail=(
                f"This export contains {total_features:,} features. Narrow the applied "
                f"Analytics scope to {_MAX_DETAIL_ROWS:,} features or fewer and retry."
            ),
        )

    conditions = feature_conditions(
        dataset_ids, categories, wards, severity_buckets, missing_field
    )
    rows = (
        await db.execute(
            select(
                Feature.id.label("feature_id"),
                Feature.dataset_id,
                Dataset.name.label("dataset_name"),
                Dataset.ward,
                Feature.label,
                CATEGORY_EXPR.label("category"),
                Feature.severity,
                func.GeometryType(Feature.geom).label("geometry_type"),
                Feature.created_at,
                Feature.attributes,
                func.ST_AsText(Feature.geom).label("wkt"),
                func.ST_AsGeoJSON(Feature.geom, 6).label("geojson_geometry"),
            )
            .join(Dataset, Dataset.id == Feature.dataset_id)
            .where(*conditions)
            .order_by(Feature.severity.desc(), Feature.created_at, Feature.id)
        )
    ).all()

    return [
        ExportRow(
            feature_id=row.feature_id,
            dataset_id=row.dataset_id,
            dataset_name=str(row.dataset_name),
            ward=row.ward,
            label=row.label,
            category=str(row.category),
            severity=float(row.severity or 0.0),
            geometry_type=str(row.geometry_type or "Unknown"),
            created_at=row.created_at,
            attributes=row.attributes if isinstance(row.attributes, dict) else {},
            wkt=str(row.wkt or ""),
            geojson_geometry=str(row.geojson_geometry or "null"),
        )
        for row in rows
    ]


def _csv_bytes(rows: list[ExportRow]) -> bytes:
    output = StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(
        [
            "feature_id",
            "dataset_id",
            "dataset_name",
            "ward",
            "label",
            "category",
            "severity",
            "severity_bucket",
            "geometry_type",
            "created_at",
            "attributes_json",
            "wkt",
        ]
    )
    for row in rows:
        writer.writerow(
            [
                str(row.feature_id),
                str(row.dataset_id),
                row.dataset_name,
                row.ward or "",
                row.label or "",
                row.category,
                round(row.severity, 6),
                _severity_bucket(row.severity),
                row.geometry_type,
                row.created_at.isoformat(),
                json.dumps(row.attributes, ensure_ascii=False, sort_keys=True),
                row.wkt,
            ]
        )
    return output.getvalue().encode("utf-8-sig")


def _geojson_bytes(rows: list[ExportRow], summary: ExportSummary) -> bytes:
    features: list[dict] = []
    for row in rows:
        try:
            geometry = json.loads(row.geojson_geometry)
        except json.JSONDecodeError:
            geometry = None
        features.append(
            {
                "type": "Feature",
                "id": str(row.feature_id),
                "geometry": geometry,
                "properties": {
                    "feature_id": str(row.feature_id),
                    "dataset_id": str(row.dataset_id),
                    "dataset_name": row.dataset_name,
                    "ward": row.ward,
                    "label": row.label,
                    "category": row.category,
                    "severity": round(row.severity, 6),
                    "severity_bucket": _severity_bucket(row.severity),
                    "geometry_type": row.geometry_type,
                    "created_at": row.created_at.isoformat(),
                    "attributes": row.attributes,
                },
            }
        )
    payload = {
        "type": "FeatureCollection",
        "name": "analytics_scope_export",
        "generated_at": summary.generated_at.isoformat(),
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": features,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _style_excel_header(ws, row: int, columns: int) -> None:
    fill = PatternFill("solid", fgColor="1F6F54")
    font = Font(color="FFFFFF", bold=True)
    for cell in ws.iter_cols(min_row=row, max_row=row, min_col=1, max_col=columns):
        cell[0].fill = fill
        cell[0].font = font
        cell[0].alignment = Alignment(vertical="center")


def _autosize_sheet(ws, *, max_width: int = 42) -> None:
    for column_cells in ws.columns:
        width = 0
        for cell in column_cells[:250]:
            value = "" if cell.value is None else str(cell.value)
            width = max(width, min(len(value) + 2, max_width))
        ws.column_dimensions[get_column_letter(column_cells[0].column)].width = max(10, width)


def _xlsx_bytes(
    rows: list[ExportRow],
    summary: ExportSummary,
    quality: AnalyticsQualityReport,
) -> bytes:
    wb = Workbook()
    summary_ws = wb.active
    summary_ws.title = "Summary"
    summary_ws.freeze_panes = "A2"
    summary_ws.append(["Analytics Export Summary", "Value"])
    _style_excel_header(summary_ws, 1, 2)
    summary_ws.append(["Generated at (UTC)", summary.generated_at.isoformat()])
    for label, value in _scope_text(summary):
        summary_ws.append([label, value])
    summary_ws.append(["Total features", summary.total_features])
    summary_ws.append(["Average severity", summary.average_severity])
    summary_ws.append(["Low severity", summary.severity_counts["low"]])
    summary_ws.append(["Medium severity", summary.severity_counts["medium"]])
    summary_ws.append(["High severity", summary.severity_counts["high"]])
    summary_ws.append(["Data quality score", quality.overall_score])
    summary_ws.append(["Methodology", quality.methodology])
    summary_ws.append([])
    summary_ws.append(["Category", "Feature count"])
    _style_excel_header(summary_ws, summary_ws.max_row, 2)
    for category, count in summary.category_counts:
        summary_ws.append([category, count])
    summary_ws["B8"].number_format = "0.000"
    _autosize_sheet(summary_ws, max_width=60)

    features_ws = wb.create_sheet("Features")
    headers = [
        "Feature ID",
        "Dataset ID",
        "Dataset",
        "Ward",
        "Label",
        "Category",
        "Severity",
        "Severity Bucket",
        "Geometry Type",
        "Created At",
        "Attributes JSON",
        "WKT (may be truncated)",
    ]
    features_ws.append(headers)
    _style_excel_header(features_ws, 1, len(headers))
    features_ws.freeze_panes = "A2"
    features_ws.auto_filter.ref = f"A1:L{max(1, len(rows) + 1)}"
    for row in rows:
        features_ws.append(
            [
                str(row.feature_id),
                str(row.dataset_id),
                row.dataset_name,
                row.ward or "",
                row.label or "",
                row.category,
                row.severity,
                _severity_bucket(row.severity),
                row.geometry_type,
                row.created_at.isoformat(),
                _safe_excel_text(json.dumps(row.attributes, ensure_ascii=False, sort_keys=True)),
                _safe_excel_text(row.wkt),
            ]
        )
    for cell in features_ws["G"][1:]:
        cell.number_format = "0.000"
    _autosize_sheet(features_ws)

    findings_ws = wb.create_sheet("Attention Order")
    finding_headers = [
        "Priority",
        "Severity",
        "Affected Count",
        "Affected %",
        "Type",
        "Title",
        "Description",
        "Rule",
        "Category",
        "Attribute",
        "Evidence Feature IDs",
    ]
    findings_ws.append(finding_headers)
    _style_excel_header(findings_ws, 1, len(finding_headers))
    findings_ws.freeze_panes = "A2"
    for finding in sorted(quality.findings, key=lambda item: item.priority_score, reverse=True):
        findings_ws.append(
            [
                finding.priority_score,
                finding.severity,
                finding.affected_count,
                finding.affected_percentage,
                finding.finding_type,
                finding.title,
                finding.description,
                finding.rule,
                finding.category or "",
                finding.attribute or "",
                ", ".join(str(item) for item in finding.feature_ids),
            ]
        )
    for cell in findings_ws["D"][1:]:
        cell.number_format = "0.0%" if float(cell.value or 0) <= 1 else "0.0"
    _autosize_sheet(findings_ws, max_width=60)

    output = BytesIO()
    wb.save(output)
    return output.getvalue()


def _pdf_bytes(summary: ExportSummary, quality: AnalyticsQualityReport) -> bytes:
    output = BytesIO()
    doc = SimpleDocTemplate(
        output,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title="Analytics Intelligence Report",
        author="Davangere Urban Survey",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "AnalyticsTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=19,
        leading=23,
        textColor=colors.HexColor("#174C3C"),
        alignment=TA_CENTER,
        spaceAfter=8,
    )
    subtitle_style = ParagraphStyle(
        "AnalyticsSubtitle",
        parent=styles["Normal"],
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#53645F"),
        alignment=TA_CENTER,
        spaceAfter=12,
    )
    heading_style = ParagraphStyle(
        "AnalyticsHeading",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=15,
        textColor=colors.HexColor("#174C3C"),
        spaceBefore=8,
        spaceAfter=6,
    )
    body_style = ParagraphStyle(
        "AnalyticsBody",
        parent=styles["BodyText"],
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#25332F"),
    )
    small_style = ParagraphStyle(
        "AnalyticsSmall",
        parent=body_style,
        fontSize=7.5,
        leading=9.5,
    )

    story: list = [
        Paragraph("Analytics Intelligence Report", title_style),
        Paragraph(
            f"Generated {escape(summary.generated_at.strftime('%Y-%m-%d %H:%M UTC'))}",
            subtitle_style,
        ),
        Paragraph("Applied Analysis Scope", heading_style),
    ]

    scope_data = [[Paragraph("Scope", small_style), Paragraph("Applied value", small_style)]]
    scope_data.extend(
        [[Paragraph(escape(label), small_style), Paragraph(escape(value), small_style)] for label, value in _scope_text(summary)]
    )
    scope_table = Table(scope_data, colWidths=[38 * mm, 135 * mm], repeatRows=1)
    scope_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F6F54")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C9D5D0")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#F6F9F8")),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.extend([scope_table, Spacer(1, 8)])

    score_text = "Not available" if quality.overall_score is None else f"{quality.overall_score:.1f}/100"
    kpi_data = [
        ["Total features", "Average severity", "High severity", "Data quality"],
        [
            f"{summary.total_features:,}",
            f"{summary.average_severity:.3f}",
            f"{summary.severity_counts['high']:,}",
            score_text,
        ],
    ]
    kpi_table = Table(kpi_data, colWidths=[43 * mm] * 4)
    kpi_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDEDE7")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#174C3C")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, 1), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 0), 7.5),
                ("FONTSIZE", (0, 1), (-1, 1), 12),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#B9CCC5")),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.extend([kpi_table, Spacer(1, 8), Paragraph("Severity Distribution", heading_style)])

    severity_table = Table(
        [
            ["Low", "Medium", "High"],
            [
                f"{summary.severity_counts['low']:,}",
                f"{summary.severity_counts['medium']:,}",
                f"{summary.severity_counts['high']:,}",
            ],
        ],
        colWidths=[57 * mm] * 3,
    )
    severity_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EDF3F1")),
                ("FONTNAME", (0, 0), (-1, -1), "Helvetica-Bold"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C9D5D0")),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.append(severity_table)

    story.append(Paragraph("Top Categories", heading_style))
    category_data = [["Category", "Features"]]
    category_data.extend([[category, f"{count:,}"] for category, count in summary.category_counts[:12]])
    if len(category_data) == 1:
        category_data.append(["No category data", "0"])
    category_table = Table(category_data, colWidths=[135 * mm, 36 * mm], repeatRows=1)
    category_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F6F54")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("ALIGN", (1, 1), (1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C9D5D0")),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(category_table)

    story.extend([PageBreak(), Paragraph("Recommended Attention Order", heading_style)])
    findings = sorted(quality.findings, key=lambda item: item.priority_score, reverse=True)
    if not findings:
        story.append(Paragraph("No deterministic quality findings were generated for this scope.", body_style))
    else:
        finding_data = [["Priority", "Severity", "Finding", "Affected"]]
        for finding in findings:
            finding_data.append(
                [
                    str(finding.priority_score),
                    finding.severity.title(),
                    Paragraph(
                        f"<b>{escape(finding.title)}</b><br/>{escape(finding.description)}",
                        small_style,
                    ),
                    f"{finding.affected_count:,} ({finding.affected_percentage:.1f}%)",
                ]
            )
        finding_table = Table(
            finding_data,
            colWidths=[18 * mm, 23 * mm, 94 * mm, 36 * mm],
            repeatRows=1,
        )
        finding_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F6F54")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C9D5D0")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("ALIGN", (0, 1), (1, -1), "CENTER"),
                    ("ALIGN", (3, 1), (3, -1), "RIGHT"),
                    ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]
            )
        )
        story.append(finding_table)

    story.extend(
        [
            Spacer(1, 10),
            Paragraph("Methodology", heading_style),
            Paragraph(escape(quality.methodology), body_style),
            Spacer(1, 8),
            Paragraph(
                "This report is generated from the applied Analytics filters. "
                "Use the Excel, CSV, or GeoJSON export for feature-level evidence.",
                small_style,
            ),
        ]
    )

    doc.build(story)
    return output.getvalue()


async def build_analytics_export(
    db: AsyncSession,
    *,
    export_format: AnalyticsExportFormat,
    dataset_ids: list[uuid.UUID],
    categories: list[str],
    wards: list[str],
    severity_buckets: list[SeverityBucketName],
    missing_field: str | None = None,
) -> tuple[bytes, str, str]:
    """Return bytes, media type, and a safe download filename."""
    summary = await _build_summary(
        db,
        dataset_ids=dataset_ids,
        categories=categories,
        wards=wards,
        severity_buckets=severity_buckets,
        missing_field=missing_field,
    )
    stamp = summary.generated_at.strftime("%Y%m%d_%H%M%S")

    if export_format == "pdf":
        quality = await build_quality_report(
            db,
            dataset_ids=dataset_ids,
            categories=categories,
            wards=wards,
            severity_buckets=severity_buckets,
            missing_field=missing_field,
        )
        return (
            _pdf_bytes(summary, quality),
            "application/pdf",
            f"analytics_report_{stamp}.pdf",
        )

    rows = await _load_detail_rows(
        db,
        dataset_ids=dataset_ids,
        categories=categories,
        wards=wards,
        severity_buckets=severity_buckets,
        missing_field=missing_field,
        total_features=summary.total_features,
    )

    if export_format == "csv":
        return _csv_bytes(rows), "text/csv; charset=utf-8", f"analytics_features_{stamp}.csv"
    if export_format == "geojson":
        return (
            _geojson_bytes(rows, summary),
            "application/geo+json",
            f"analytics_features_{stamp}.geojson",
        )

    quality = await build_quality_report(
        db,
        dataset_ids=dataset_ids,
        categories=categories,
        wards=wards,
        severity_buckets=severity_buckets,
        missing_field=missing_field,
    )
    return (
        _xlsx_bytes(rows, summary, quality),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        f"analytics_workbook_{stamp}.xlsx",
    )

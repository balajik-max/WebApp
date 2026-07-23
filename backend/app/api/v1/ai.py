"""
Grounded AI endpoints — RAG loop backed by the local Ollama `ai_engine` container.

All four endpoints share the same structural guarantee:
  1. Build a deterministic textual context from real PostGIS rows.
  2. If the context is empty, return the canonical `INSUFFICIENT_ANSWER`
     WITHOUT calling Ollama.
  3. Otherwise, wrap the context inside the fixed anti-hallucination
     system prompt and forward the user's task to `llama3:8b`.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db
from app.models import User, UserRole
from app.models.feature import Feature
from app.models.spatial_anomaly import AnomalyStatus, SpatialAnomaly
from app.schemas.ai import (
    AiAnswer,
    AnomalyExplainResponse,
    AnomalyStatusUpdate,
    AuditRunRequest,
    AuditRunResponse,
    ManholeRecommendRequest,
    NLQueryRequest,
    PipeRouteOut,
    PipeSpecOut,
    RecommendRequest,
    ReportRequest,
    RoadInspectionOut,
    SpacingRequest,
    SpatialAnomalyOut,
)
from app.services.ai import (
    AI_DISCLAIMER,
    INSUFFICIENT_ANSWER,
    run_grounded_completion,
)
from app.services.ai_context import (
    ProximityFacts,
    ReportFacts,
    build_dataset_or_ward_context,
    build_feature_ids_context,
    build_proximity_facts,
    build_recommend_context,
    build_report_facts,
)
from app.services.manhole_recommend import (
    FeatureRecommendation,
    PipeRoute,
    build_feature_recommendation,
    build_full_network,
    find_coverage_gaps,
    recommend_pipe_spec,
    scan_all_manhole_recommendations,
)
from app.services.spatial_audit import run_spatial_audit
from app.services.road_inspection import build_road_inspection

log = logging.getLogger("davangere.api.ai")
router = APIRouter()

# ---------------------------------------------------------------------------
# Urban Planning Solution — user-provided text/files → AI explanation
# ---------------------------------------------------------------------------
SUPPORTED_EXTS = {".txt", ".pdf", ".docx"}

async def _extract_file_text(file: UploadFile) -> str:
    content = await file.read()
    name = (file.filename or "").lower()

    if name.endswith(".txt"):
        return content.decode("utf-8", errors="replace")

    if name.endswith(".pdf"):
        from io import BytesIO
        from pypdf import PdfReader
        reader = PdfReader(BytesIO(content))
        return "\n".join(page.extract_text() or "" for page in reader.pages)

    if name.endswith(".docx"):
        from io import BytesIO
        import docx
        doc = docx.Document(BytesIO(content))
        return "\n".join(p.text for p in doc.paragraphs)

    return f"[Unsupported file: {file.filename} — skipped]"


def _build_feature_context(feature: Feature | None) -> str:
    if feature is None:
        return "FEATURE: Feature not found in database."
    label = (feature.category or "FEATURE").upper()
    lines = [
        f"=== {label} SURVEY DATA ===",
        f"Feature ID: {feature.id}",
        f"Label: {feature.label or 'N/A'}",
        f"Category: {feature.category or 'N/A'}",
        f"Severity: {feature.severity:.2f}",
        "--- Survey Attributes ---",
    ]
    attrs = feature.attributes or {}
    key_fields = [
        "Condition", "condition",
        "Top_Level", "top_level", "RL", "rl",
        "Bottom_Level", "bottom_level", "Invert_Level", "invert_level",
        "Silt_Level", "silt_level",
        "Gradient", "gradient",
        "Pipe_Type", "pipe_type",
        "Diameter", "diameter",
        "Cover_Type", "cover_type",
        "Road_Name", "road_name",
        "Ward", "ward",
        "X_Long", "x_long", "Y_Lat", "y_lat",
        "Remarks", "remarks", "Notes", "notes",
    ]
    shown = set()
    for key in key_fields:
        val = attrs.get(key)
        if val is not None and key not in shown:
            lines.append(f"  {key}: {val}")
            shown.add(key)
    for k, v in attrs.items():
        if k not in shown and v is not None and str(v).strip():
            lines.append(f"  {k}: {v}")
    return "\n".join(lines)


def _build_anomaly_context(anomaly: SpatialAnomaly) -> str:
    """Uses the same curated, per-type fact sheet the /explain endpoint
    hands the LLM (issue/basis/connectivity/clearance facts, not a raw
    metadata dict dump) — the solution-suitability check needs to reason
    against the actual identified issue, not guess it from opaque keys."""
    lines = [
        "=== AI ANOMALY FINDING ===",
        f"Type: {anomaly.anomaly_type.value}",
        f"Color: {anomaly.color.value}",
        f"Severity Score: {anomaly.severity_score:.1f}/100",
        f"Status: {anomaly.status.value}",
        "",
        _anomaly_fact_sheet(anomaly),
    ]
    if anomaly.explanation_text:
        lines.append(f"\nAI Explanation already generated for this finding: {anomaly.explanation_text}")
    return "\n".join(lines)


def _build_road_inspection_context(report: dict) -> str:
    """Render one real road-inspection report as deterministic context.

    All values come from build_road_inspection; the LLM only evaluates the
    user's proposal against these persisted survey and audit facts.
    """
    assets = report.get("assets") or {}
    issues = report.get("issues") or []
    lines = [
        "=== ROAD INSPECTION DATA ===",
        f"Road ID: {report.get('road_id')}",
        f"Road label: {report.get('road_label') or 'not recorded'}",
        f"Road category: {report.get('road_category') or 'not recorded'}",
        f"Surveyed centerline length: {report.get('road_length_m')} m",
        f"Roadside audit corridor: {report.get('roadside_corridor_m')} m",
        f"Assigned roadside assets: poles={assets.get('poles', 0)}, drains={assets.get('drains', 0)}, manholes={assets.get('manholes', 0)}",
        f"Unresolved red/yellow findings: {len(issues)}",
    ]
    if not issues:
        lines.append("No unresolved red or yellow audit finding is currently assigned to this road.")
        return "\n".join(lines)

    for index, issue in enumerate(issues, start=1):
        metadata = issue.get("anomaly_metadata") or {}
        lines.extend([
            "",
            f"--- Road finding {index} ---",
            f"Type: {issue.get('anomaly_type')}",
            f"Color: {issue.get('color')}",
            f"Severity score: {issue.get('severity_score')}/100",
            f"Status: {issue.get('status')}",
            f"Longitude: {issue.get('lon')}",
            f"Latitude: {issue.get('lat')}",
        ])
        for key, value in metadata.items():
            if value is not None and str(value).strip():
                lines.append(f"  {key}: {value}")
    return "\n".join(lines)


@router.post(
    "/urban-planning-solution",
    response_model=AiAnswer,
    dependencies=[Depends(require_any)],
    summary="Generate an AI explanation from user-provided solution text and/or files",
)
async def urban_planning_solution(
    feature_id: uuid.UUID = Form(...),
    solution_text: str | None = Form(default=None, max_length=50000),
    files: list[UploadFile] = File(default=[]),
    db: AsyncSession = Depends(get_db),
) -> AiAnswer:
    from app.core.config import get_settings

    model = get_settings().ollama_model

    gathered: list[str] = []

    if solution_text and solution_text.strip():
        gathered.append(f"## User's Written Solution\n{solution_text.strip()}\n")

    for f in files:
        if f.filename:
            ext = Path(f.filename).suffix.lower()
            if ext not in SUPPORTED_EXTS:
                gathered.append(f"[Skipped unsupported file: {f.filename}]\n")
                continue
        try:
            text = await _extract_file_text(f)
            if text.strip():
                gathered.append(f"## Uploaded File: {f.filename}\n{text.strip()}\n")
        except Exception as exc:
            gathered.append(f"[Error reading {f.filename}: {exc}]\n")

    combined = "\n".join(gathered).strip()
    if not combined:
        return _insufficient(
            "urban_planning",
            model,
            {"reason": "no solution text or file content provided"},
        )

    feature = (await db.execute(select(Feature).where(Feature.id == feature_id))).scalar_one_or_none()
    anomaly = (
        await db.execute(
            select(SpatialAnomaly)
            .where(SpatialAnomaly.feature_ids.any(feature_id))
            .order_by(SpatialAnomaly.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    road_report = await build_road_inspection(feature_id, db)

    feature_section = _build_feature_context(feature)
    anomaly_section = _build_anomaly_context(anomaly) if anomaly else "ANOMALY: No active anomaly finding for this feature."
    road_section = _build_road_inspection_context(road_report) if road_report else "ROAD INSPECTION: The selected feature is not a surveyed road centerline."
    user_section = f"## User's Proposed Solution\n{combined}"

    context = (
        f"{feature_section}\n\n"
        f"{anomaly_section}\n\n"
        f"{road_section}\n\n"
        f"{user_section}"
    )

    anomaly_type = anomaly.anomaly_type.value if anomaly else None
    subject = "manhole" if anomaly_type in (None, "manhole_status") else "feature"

    if road_report is not None:
        user_prompt = (
            "You are a senior municipal road, pavement, drainage, and traffic-safety engineer "
            "evaluating a proposed solution for one surveyed road inspection. Below you have:\n"
            "1. The ROAD SURVEY DATA from the selected centerline\n"
            "2. The ROAD INSPECTION DATA, including real unresolved findings and roadside assets\n"
            "3. The USER'S PROPOSED SOLUTION\n\n"
            "Generate a structured evaluation using exactly these sections:\n\n"
            "`## Current Road Inspection` — Summarize the surveyed road length, roadside assets, "
            "and every unresolved finding. Cite only values present in the context.\n\n"
            "`## Summary of Proposed Solution` — Restate the user's proposal accurately.\n\n"
            "`## Suitability Assessment` — Check whether the proposal addresses the actual road "
            "findings. Consider pavement distress, road-width narrowing, potholes, standing water, "
            "drainage influence, base failure, surface treatment, material and layer thickness, "
            "estimated quantity when supplied, traffic diversion, pedestrian/two-wheeler safety, "
            "construction sequencing, and post-repair inspection. Do not require an item when the "
            "inspection data gives no evidence for it.\n\n"
            "`## Verdict` — State **Suitable**, **Partially Suitable**, or **Not Suitable**, with a "
            "brief technical reason.\n\n"
            "`## Recommendations` — Give concrete corrections or additions grounded only in the "
            "road inspection facts. Separate immediate safety controls from permanent repair.\n\n"
            "CRITICAL: Never invent a road width, layer thickness, quantity, material, defect, or "
            "location. If a required design input is missing, identify it as a field verification "
            "or engineering-design requirement. Do not mark the proposal Suitable unless it resolves "
            "the actual findings listed in ROAD INSPECTION DATA.\n\n"
            f"CONTEXT:\n{context}"
        )
    elif anomaly_type == "pothole_status":
        user_prompt = (
            "You are a senior pavement-maintenance and municipal road-safety engineer evaluating "
            "a proposed solution for one mapped pothole. Below you have the real survey attributes, "
            "the persisted pothole audit finding, and the user's proposal.\n\n"
            "Generate a structured evaluation using exactly these sections:\n\n"
            "`## Current Pothole Condition` — Cite the mapped area, depth, estimated repair volume, "
            "severity, road relationship, and any stated basis that actually appear in the context.\n\n"
            "`## Summary of Proposed Solution` — Restate the proposal.\n\n"
            "`## Suitability Assessment` — Evaluate whether the proposed treatment matches the real "
            "severity and likely repair depth. Check edge cutting, removal of loose/failed material, "
            "base repair where needed, tack coat, patch material, layer placement and compaction, "
            "surface level, drainage/water ingress, traffic control, quantity adequacy, and post-rain "
            "inspection. Distinguish a superficial patch from full-depth repair when the facts justify it.\n\n"
            "`## Verdict` — State **Suitable**, **Partially Suitable**, or **Not Suitable**, with a reason.\n\n"
            "`## Recommendations` — Give exact improvements grounded in the available facts.\n\n"
            "CRITICAL: Never invent dimensions, depth, volume, pavement composition, material, or "
            "traffic condition. Missing design inputs must be stated as missing. Mark Suitable only "
            "when the proposal addresses the actual mapped pothole condition, not merely its visible surface.\n\n"
            f"CONTEXT:\n{context}"
        )
    elif anomaly_type == "standing_water_status":
        user_prompt = (
            "You are a senior urban-drainage, road-level, and public-safety engineer evaluating a "
            "proposed solution for one mapped standing-water area. Below you have the real survey "
            "attributes, persisted audit finding, and user's proposal.\n\n"
            "Generate a structured evaluation using exactly these sections:\n\n"
            "`## Current Standing-Water Condition` — Cite the mapped area, recorded depth when available, "
            "road intersection/distance, drain intersection/distance, severity, and stated cause/basis.\n\n"
            "`## Summary of Proposed Solution` — Restate the proposal.\n\n"
            "`## Suitability Assessment` — Determine whether the proposal addresses the root cause rather "
            "than only removing water temporarily. Check drain/inlet cleaning, downstream flow, blockage, "
            "road depression, crossfall, regrading, inlet provision, outfall availability, pavement repair, "
            "temporary pumping, recurrence risk, pedestrian/traffic safety, and maintenance access.\n\n"
            "`## Verdict` — State **Suitable**, **Partially Suitable**, or **Not Suitable**, with a reason.\n\n"
            "`## Recommendations` — Separate immediate dewatering/safety measures from the permanent "
            "drainage or level-correction work.\n\n"
            "CRITICAL: Never invent water depth, drain capacity, invert level, road level, rainfall, or outfall. "
            "If those inputs are absent, require field verification. Pumping alone is temporary unless the "
            "proposal also resolves the evidenced drainage or surface-level cause.\n\n"
            f"CONTEXT:\n{context}"
        )
    elif anomaly_type == "powerline_proximity":
        user_prompt = (
            "You are a senior electrical-safety and urban infrastructure engineer "
            "evaluating a proposed solution for a building flagged too close to a "
            "power line. Below you have:\n"
            "1. The BUILDING SURVEY DATA (real attributes from the GIS database)\n"
            "2. The AI ANOMALY FINDING (automated clearance-distance audit result)\n"
            "3. The USER'S PROPOSED SOLUTION (what the user suggests doing)\n\n"
            "Generate a structured evaluation with these sections:\n\n"
            "`## Current Clearance Finding` — Summarize the real surveyed distance to "
            "the nearest power line, the clearance thresholds, and the conductor "
            "height. Cite specific figures from the finding.\n\n"
            "`## Summary of Proposed Solution` — Restate what the user is proposing.\n\n"
            "`## Suitability Assessment` — Evaluate whether the proposed solution actually "
            "restores electrical safety clearance. Consider:\n"
            "  - Does it address the real hazard (an under-clearance bare/uninsulated "
            "conductor near an occupied structure), not just move the problem?\n"
            "  - Is it something a building owner can do (e.g. insulating exposed "
            "metal fixtures, keeping the roof/terrace unused near the line), or does it "
            "require the electricity board (raising/rerouting the line, replacing bare "
            "conductor with insulated cable)?\n"
            "  - A proposal to relocate or demolish the building is almost never the "
            "right answer for a clearance issue and should be marked Not Suitable "
            "unless the user's own text shows the line genuinely cannot be modified.\n"
            "  - Insulated/PVC or XLPE-covered conductor, or increasing the physical "
            "clearance from the line side, is the standard fix — judge the proposal "
            "against that standard.\n\n"
            "`## Verdict` — Clearly state whether the solution is: **Suitable**, **Partially Suitable** "
            "(with modifications needed), or **Not Suitable**. Give a brief reason.\n\n"
            "`## Recommendations` — Concrete, standard electrical-safety suggestions to improve "
            "or correct the proposal, grounded only in the data provided.\n\n"
            "CRITICAL: Base your entire response ONLY on the data provided below. Never invent "
            "attribute values. If specific data is missing, state that clearly. Do NOT default "
            "to 'Suitable' as a courtesy — you are a safety reviewer, not a cheerleader. Before "
            "writing the Verdict, check the proposal against the 'Issue:'/'Required:' facts in "
            "the AI ANOMALY FINDING above line by line: if the proposal does not restore the "
            "specific clearance/insulation problem stated there, or only treats a symptom "
            "(e.g. it modifies the building instead of the line, or ignores the actual "
            "clearance distance given), the Verdict MUST be Partially Suitable or Not Suitable "
            "and you must say exactly what part of the real issue is left unaddressed. Only "
            "mark Suitable if the proposal genuinely fixes the exact clearance problem in FACTS.\n\n"
            f"CONTEXT:\n{context}"
        )
    else:
        user_prompt = (
            f"You are a senior urban infrastructure engineer evaluating a proposed solution "
            f"for a specific {subject}. Below you have:\n"
            f"1. The SURVEY DATA (real attributes from the GIS database)\n"
            f"2. The AI ANOMALY FINDING (automated audit result for this {subject})\n"
            "3. The USER'S PROPOSED SOLUTION (what the user suggests doing)\n\n"
            "Generate a structured evaluation with these sections:\n\n"
            f"`## Current Condition` — Summarize this {subject}'s real surveyed condition and "
            "any AI anomaly finding. Cite specific attribute values from the survey data.\n\n"
            "`## Summary of Proposed Solution` — Restate what the user is proposing.\n\n"
            f"`## Suitability Assessment` — Evaluate whether the proposed solution is appropriate "
            f"for THIS specific {subject}'s condition. Consider:\n"
            "  - Does the solution address the actual surveyed issues?\n"
            "  - Are the proposed materials/approach appropriate for the existing setup?\n"
            "  - Are there any gaps or mismatches between the solution and the real condition?\n\n"
            f"`## Verdict` — Clearly state whether the solution is: **Suitable**, **Partially Suitable** "
            f"(with modifications needed), or **Not Suitable** for this {subject}. Give a brief reason.\n\n"
            "`## Recommendations` — Concrete suggestions to improve or adjust the solution based "
            "on the actual surveyed attributes.\n\n"
            "CRITICAL: Base your entire response ONLY on the data provided below. Never invent "
            "attribute values. If specific data is missing, state that clearly. Do NOT default "
            "to 'Suitable' as a courtesy — you are a technical reviewer, not a cheerleader. Before "
            "writing the Verdict, check the proposal against the specific issue named in the "
            "AI ANOMALY FINDING above (its 'Issue:'/'Required:' lines if present, otherwise its "
            "stated finding) point by point: if the proposal does not address that exact "
            f"problem, or only treats a symptom instead of the real cause described for this {subject}, "
            "the Verdict MUST be Partially Suitable or Not Suitable, and you must state exactly "
            "what part of the real issue is left unaddressed. Only mark Suitable if the proposal "
            "genuinely resolves the specific problem in FACTS.\n\n"
            f"CONTEXT:\n{context}"
        )

    reply = await run_grounded_completion(context=context, user_prompt=user_prompt, num_predict=1024, num_ctx=4096)

    return AiAnswer(
        kind="urban_planning",
        model=reply.model,
        prompt_tokens_hint=reply.prompt_tokens_hint,
        context_rows=len(gathered),
        grounded=True,
        answer_markdown=reply.text,
        generated_at=datetime.now(timezone.utc),
        debug={"feature_id": str(feature_id)},
    )


def _insufficient(kind: str, model: str, debug: dict | None) -> AiAnswer:
    return AiAnswer(
        kind=kind,  # type: ignore[arg-type]
        model=model,
        prompt_tokens_hint=0,
        context_rows=0,
        grounded=False,
        answer_markdown=INSUFFICIENT_ANSWER,
        generated_at=datetime.now(timezone.utc),
        debug=debug,
    )


def _render_facts_markdown(facts: ReportFacts) -> str:
    """Renders the factual front half of the report directly from SQL
    results — no LLM involved, so these numbers can never be wrong."""
    lines: list[str] = []

    lines.append("## Executive Summary")
    lines.append(
        f"This report covers **{facts.total_features} surveyed features** across "
        f"**{facts.distinct_categories} categories** in **{facts.scope_label}**, "
        f"drawn from {facts.distinct_datasets} dataset(s). The average severity "
        f"score across all features is **{facts.avg_severity:.2f}** (0-1 scale)."
    )
    lines.append("")

    lines.append("## Study Area")
    lines.append(f"- Scope: {facts.scope_label}")
    lines.append(f"- Total features surveyed: {facts.total_features}")
    lines.append(f"- Distinct categories: {facts.distinct_categories}")
    lines.append(f"- Datasets contributing to this scope: {facts.distinct_datasets}")
    lines.append(f"- Review backlog: {facts.review_summary}")
    lines.append("")

    lines.append("## Existing Situation")
    lines.append("Category breakdown across every matching feature (full count, not a sample):")
    lines.append("")
    lines.append("| Category | Count | Avg Severity |")
    lines.append("|---|---|---|")
    shown = facts.categories[:15]
    for c in shown:
        lines.append(f"| {c.category} | {c.count} | {c.avg_severity:.2f} |")
    if len(facts.categories) > len(shown):
        lines.append(f"| …and {len(facts.categories) - len(shown)} more categories | | |")
    lines.append("")
    lines.append(
        f"Severity distribution: **{facts.severity_buckets['high']} high**, "
        f"**{facts.severity_buckets['medium']} medium**, "
        f"**{facts.severity_buckets['low']} low** severity features."
    )
    lines.append("")

    lines.append("## Verified Data Quality Findings")
    if facts.quality_score is not None:
        lines.append(f"- Overall deterministic data quality score: **{facts.quality_score:.1f}/100**")
    if facts.quality_findings:
        lines.append("")
        lines.append("| Priority | Severity | Finding | Affected |")
        lines.append("|---:|---|---|---:|")
        for finding in facts.quality_findings:
            lines.append(
                f"| {finding.priority_score} | {finding.severity} | {finding.title} | "
                f"{finding.affected_count} ({finding.affected_percentage:.1f}%) |"
            )
    else:
        lines.append("- No configured quality issue was found in this scope.")
    lines.append("")

    lines.append("## Key Findings")
    if facts.top_features:
        lines.append("Highest-severity individual features on record:")
        lines.append("")
        for f in facts.top_features:
            lines.append(f"- **{f.label}** ({f.category}) — severity {f.severity:.2f}, from *{f.dataset_name}*")
    else:
        lines.append("No features with elevated severity were found in this scope.")

    return "\n".join(lines)


def _facts_crib_sheet(facts: ReportFacts) -> str:
    """A short, verified fact sheet handed to the LLM for the
    narrative-only sections — deliberately terse so there's little room
    for it to latch onto anything to misread."""
    top_categories = ", ".join(f"{c.category} ({c.count})" for c in facts.categories[:10])
    examples = "\n".join(
        f"  - {f.label} ({f.category}), severity {f.severity:.2f}" for f in facts.top_features
    ) or "  - none"
    quality_findings = "\n".join(
        f"  - priority={finding.priority_score}; severity={finding.severity}; "
        f"finding={finding.title}; affected={finding.affected_count} "
        f"({finding.affected_percentage:.1f}%); rule={finding.rule}"
        for finding in facts.quality_findings
    ) or "  - none"
    return (
        f"SCOPE: {facts.scope_label}\n"
        f"TOTAL_FEATURES: {facts.total_features}\n"
        f"DISTINCT_CATEGORIES: {facts.distinct_categories}\n"
        f"TOP_CATEGORIES (real name and count — do not invent any other category name): {top_categories}\n"
        f"SEVERITY_BUCKETS: high={facts.severity_buckets['high']}, "
        f"medium={facts.severity_buckets['medium']}, low={facts.severity_buckets['low']}\n"
        f"REVIEW_BACKLOG: {facts.review_summary}\n"
        f"DATA_QUALITY_SCORE: {facts.quality_score if facts.quality_score is not None else 'not available'}\n"
        f"VERIFIED_QUALITY_FINDINGS (exact backend-calculated values; never alter):\n{quality_findings}\n"
        f"HIGH_SEVERITY_EXAMPLES (real labels — cite verbatim only, never alter):\n{examples}"
    )


# ---------------------------------------------------------------------------
# POST /api/v1/ai/report
# ---------------------------------------------------------------------------
@router.post(
    "/report",
    response_model=AiAnswer,
    dependencies=[Depends(require_any)],
    summary="Full ward/dataset-level neighbourhood regeneration report",
)
async def report(body: ReportRequest, db: AsyncSession = Depends(get_db)) -> AiAnswer:
    dataset_ids = list(dict.fromkeys(body.dataset_ids))
    if body.dataset_id is not None and body.dataset_id not in dataset_ids:
        dataset_ids.append(body.dataset_id)
    categories = sorted({value.strip() for value in body.categories if value.strip()})
    if any(len(value) > 128 for value in categories):
        raise HTTPException(status_code=400, detail="category values must be at most 128 characters")
    if not body.all_datasets and not dataset_ids and body.ward is None:
        raise HTTPException(
            status_code=400,
            detail="Provide dataset_id, dataset_ids, ward, or set all_datasets=true",
        )

    from app.core.config import get_settings
    settings = get_settings()
    model = settings.ollama_model

    facts = await build_report_facts(
        db,
        dataset_id=None,
        dataset_ids=dataset_ids,
        ward=body.ward,
        categories=categories,
        severity_buckets=list(dict.fromkeys(body.severity_buckets)),
        allow_all=body.all_datasets,
        top_feature_limit=min(body.max_features, 25),
    )
    if facts is None:
        return _insufficient("report", model, {"reason": "no matching features"})

    # Every count/category/id the report states comes from `facts`
    # (computed by SQL, rendered by Python below) — the LLM is never
    # asked to recall or restate a number itself, only to write
    # narrative/prescriptive prose around facts it's handed. This is a
    # deliberate response to real hallucinations seen in testing (an
    # invented "Divider" category, a lat/long mistaken for a feature id,
    # a sample size reported as the area's total) even with a strict
    # grounding prompt — a 7B CPU model just isn't reliable enough to be
    # trusted with the numbers themselves.
    facts_markdown = _render_facts_markdown(facts)
    crib = _facts_crib_sheet(facts)

    narrative_prompt = (
        "You are writing the back half of a neighbourhood-regeneration "
        "planning report. The front half (already written, shown below as "
        "FACTS) covers the Executive Summary, Study Area, Existing "
        "Situation, and Key Findings — do not repeat or restate those.\n\n"
        "Using ONLY the FACTS below, including the verified quality findings, write these remaining sections, using "
        "exactly these headers in order:\n\n"
        "`## Quality of Life Implications` — plain-language consequences "
        "for residents that plausibly follow from the categories/severity "
        "in FACTS (e.g. closed drains -> stagnant water/mosquito risk). Do "
        "not list generic urban problems unrelated to the categories given.\n\n"
        "`## Strategic Opportunities` — 3-5 opportunities a civic engineer "
        "could pursue, each justified by a category or finding in FACTS.\n\n"
        "`## Phased Improvement Strategy` — three sub-sections `Immediate "
        "(0-12 months)`, `Short-Term (1-3 Years)`, `Long-Term (3-10 Years)`, "
        "bullet lists of actions addressing the categories in FACTS, "
        "highest-severity items first.\n\n"
        "`## Expected Outcomes` — bullet list of realistic improvements if "
        "the phases above are carried out.\n\n"
        "`## Investment Priorities` — which categories should be funded "
        "first and why, based on the severity/count figures in FACTS — "
        "never invent a specific budget figure.\n\n"
        "`## Monitoring & Performance` — 4-6 KPIs this survey system could "
        "track over time (e.g. open review count, avg severity, "
        "category-specific counts) — only metrics this database could "
        "actually produce.\n\n"
        "`## Conclusion` — 2-3 sentences tying the findings back to the "
        "opportunity for coordinated improvement.\n\n"
        "CRITICAL RULE: never state a specific number, percentage, or "
        "category name that is not written verbatim in FACTS below. If you "
        "need to reference 'the most common issue', use the exact category "
        "name from FACTS — never a category that isn't listed there.\n\n"
        f"FACTS:\n{crib}"
    )
    reply = await run_grounded_completion(
        context=crib,
        user_prompt=narrative_prompt,
        num_predict=1200,
        num_ctx=4096,
    )

    return AiAnswer(
        kind="report",
        model=reply.model,
        prompt_tokens_hint=reply.prompt_tokens_hint,
        context_rows=facts.total_features,
        grounded=True,
        answer_markdown=f"{facts_markdown}\n\n{reply.text}",
        generated_at=datetime.now(timezone.utc),
        debug={"scope": facts.scope_label, "total_features": facts.total_features},
    )


# ---------------------------------------------------------------------------
# POST /api/v1/ai/query
# ---------------------------------------------------------------------------
@router.post(
    "/query",
    response_model=AiAnswer,
    dependencies=[Depends(require_any)],
    summary="Natural-language question answered strictly from PostGIS data",
)
async def query(body: NLQueryRequest, db: AsyncSession = Depends(get_db)) -> AiAnswer:
    from app.core.config import get_settings
    model = get_settings().ollama_model

    # Prefer explicit feature_ids selection; else fall back to dataset/ward scope.
    if body.feature_ids:
        ctx = await build_feature_ids_context(db, feature_ids=list(body.feature_ids))
    elif body.dataset_id is not None or body.ward is not None:
        ctx = await build_dataset_or_ward_context(
            db,
            dataset_id=body.dataset_id,
            ward=body.ward,
            category=body.category,
            max_features=body.max_features,
        )
    else:
        return _insufficient(
            "query",
            model,
            {"reason": "no scope: supply dataset_id, ward, or feature_ids"},
        )

    if ctx.count == 0:
        return _insufficient("query", model, ctx.debug)

    reply = await run_grounded_completion(
        context=ctx.text,
        user_prompt=(
            f"User's question:\n{body.question.strip()}\n\n"
            "Answer strictly from the DATABASE CONTEXT above. If the context "
            "includes a CATEGORY BREAKDOWN, that is the real, complete total "
            "for the whole scope — use it for any count/composition claim. "
            "A 'TOP FEATURES' list, if present, is only a severity-sorted "
            "SAMPLE of individual examples, not the full picture — never "
            "state or imply overall composition/totals from it, and never "
            "name a category that doesn't literally appear in the context."
        ),
    )
    return AiAnswer(
        kind="query",
        model=reply.model,
        prompt_tokens_hint=reply.prompt_tokens_hint,
        context_rows=ctx.count,
        grounded=True,
        answer_markdown=reply.text,
        generated_at=datetime.now(timezone.utc),
        debug=ctx.debug,
    )


# ---------------------------------------------------------------------------
# POST /api/v1/ai/recommend
# ---------------------------------------------------------------------------
@router.post(
    "/recommend",
    response_model=AiAnswer,
    dependencies=[Depends(require_any)],
    summary="Suggest mitigation actions for a single feature",
)
async def recommend(body: RecommendRequest, db: AsyncSession = Depends(get_db)) -> AiAnswer:
    from app.core.config import get_settings
    model = get_settings().ollama_model

    ctx = await build_recommend_context(db, feature_id=body.feature_id)
    if ctx.count == 0:
        # Feature was not found or has no data at all.
        return AiAnswer(
            kind="recommend",
            model=model,
            prompt_tokens_hint=0,
            context_rows=0,
            grounded=False,
            answer_markdown=f"{INSUFFICIENT_ANSWER}\n\n{AI_DISCLAIMER}",
            generated_at=datetime.now(timezone.utc),
            disclaimer=AI_DISCLAIMER,
            debug=ctx.debug,
        )

    user_prompt = (
        "Produce mitigation and remediation recommendations for the FEATURE "
        "above, taking its review items and comments into account. Format as "
        "markdown with these sections:\n\n"
        "1. `## Observed Issue` — one-paragraph restatement based ONLY on the "
        "attributes, review titles and comments.\n"
        "2. `## Proposed Actions` — a numbered list of concrete engineering "
        "steps. Each item should reference the field or comment that justifies "
        "it (cite the raw context).\n"
        "3. `## Sequencing & Preconditions` — ordering, safety notes, "
        "coordination touchpoints.\n"
        "4. `## Open Questions` — anything you cannot infer from the context "
        "and would need an engineer to confirm.\n\n"
        "Only one feature is described in the context above — do not invent "
        "counts, additional features, or categories beyond what's shown "
        "there; every attribute/value you cite must appear verbatim above.\n\n"
        "At the very END of your response, append exactly this line on its "
        f"own, verbatim: {AI_DISCLAIMER}"
    )
    reply = await run_grounded_completion(context=ctx.text, user_prompt=user_prompt)

    # Guarantee the disclaimer is present even if the model dropped it.
    answer = reply.text
    if AI_DISCLAIMER not in answer:
        answer = answer.rstrip() + f"\n\n{AI_DISCLAIMER}"

    return AiAnswer(
        kind="recommend",
        model=reply.model,
        prompt_tokens_hint=reply.prompt_tokens_hint,
        context_rows=ctx.count,
        grounded=True,
        answer_markdown=answer,
        generated_at=datetime.now(timezone.utc),
        disclaimer=AI_DISCLAIMER,
        debug=ctx.debug,
    )


# ---------------------------------------------------------------------------
# Spacing / redundancy facts rendering — same rule as the report: every
# distance and count below comes straight from `build_proximity_facts`
# (a real PostGIS geography self-join), never from the LLM.
# ---------------------------------------------------------------------------
def _render_spacing_markdown(facts: ProximityFacts) -> str:
    lines: list[str] = []
    lines.append(
        f"## Spacing Check — {facts.category} in {facts.scope_label}"
    )
    lines.append(
        f"**{facts.total_in_scope}** `{facts.category}` feature(s) in scope, checked pairwise "
        f"for anything closer than **{facts.threshold_m:.0f} m**."
    )
    lines.append("")

    if not facts.pairs:
        lines.append(f"No two `{facts.category}` features are within {facts.threshold_m:.0f} m of each other.")
        return "\n".join(lines)

    lines.append(
        f"Found **{len(facts.pairs)} pair(s)** within range, forming "
        f"**{len(facts.cluster_sizes)} cluster(s)** covering **{facts.clustered_feature_count}** "
        f"of the {facts.total_in_scope} features."
    )
    lines.append(
        f"AI recommendation overlay: **{len(facts.redundant_feature_ids)} red** "
        f"(very close duplicate removal-review) and **{len(facts.needed_locations)} green** "
        f"(proposed missing/service-gap locations). The red decision used a conservative duplicate "
        f"rule inside a **{facts.local_graph_threshold_m:.1f} m** local review graph, while this report "
        f"still searched up to **{facts.threshold_m:.0f} m**."
    )
    lines.append("")
    lines.append("| Feature A | Feature B | Distance |")
    lines.append("|---|---|---|")
    shown = facts.pairs[:20]
    for p in shown:
        lines.append(f"| {p.label_a} | {p.label_b} | {p.distance_m:.1f} m |")
    if len(facts.pairs) > len(shown):
        lines.append(f"| …and {len(facts.pairs) - len(shown)} more pairs | | |")

    return "\n".join(lines)


def _spacing_crib_sheet(facts: ProximityFacts) -> str:
    pair_lines = "\n".join(
        f"  - {p.label_a} <-> {p.label_b}: {p.distance_m:.1f} m apart" for p in facts.pairs[:15]
    ) or "  - none"
    return (
        f"CATEGORY: {facts.category}\n"
        f"SCOPE: {facts.scope_label}\n"
        f"THRESHOLD_M: {facts.threshold_m:.0f}\n"
        f"TOTAL_IN_SCOPE: {facts.total_in_scope}\n"
        f"PAIRS_WITHIN_THRESHOLD: {len(facts.pairs)}\n"
        f"CLUSTER_SIZES (a cluster is a group of features each within threshold of another in the group): "
        f"{facts.cluster_sizes}\n"
        f"CLUSTERED_FEATURE_COUNT: {facts.clustered_feature_count}\n"
        f"LOCAL_GRAPH_THRESHOLD_M_FOR_RED_GREEN: {facts.local_graph_threshold_m:.1f}\n"
        f"MAX_REMOVAL_GAP_M: {facts.max_removal_gap_m:.1f}\n"
        f"AI_RED_RECOMMENDED_REMOVAL_COUNT: {len(facts.redundant_feature_ids)}\n"
        f"AI_GREEN_PROPOSED_SERVICE_GAP_COUNT: {len(facts.needed_locations)}\n"
        f"CLOSEST_PAIRS (real measured distances — never alter or invent a distance):\n{pair_lines}"
    )


# ---------------------------------------------------------------------------
# POST /api/v1/ai/spacing
# ---------------------------------------------------------------------------
@router.post(
    "/spacing",
    response_model=AiAnswer,
    dependencies=[Depends(require_any)],
    summary="Detect features of one category placed unusually close together (e.g. redundant poles)",
)
async def spacing(body: SpacingRequest, db: AsyncSession = Depends(get_db)) -> AiAnswer:
    if body.dataset_id is None and body.ward is None:
        raise HTTPException(status_code=400, detail="Provide either dataset_id or ward")

    from app.core.config import get_settings
    model = get_settings().ollama_model

    facts = await build_proximity_facts(
        db,
        dataset_id=body.dataset_id,
        ward=body.ward,
        category=body.category,
        threshold_m=body.distance_m,
    )
    if facts is None:
        return _insufficient(
            "spacing", model, {"reason": "no features of that category in scope"}
        )

    facts_markdown = _render_spacing_markdown(facts)

    if not facts.pairs:
        # Nothing to analyze — every real number is already stated above,
        # no ambiguity for a model to narrate around, so skip the LLM call.
        return AiAnswer(
            kind="spacing",
            model=model,
            prompt_tokens_hint=0,
            context_rows=facts.total_in_scope,
            grounded=True,
            answer_markdown=facts_markdown,
            generated_at=datetime.now(timezone.utc),
            debug={"scope": facts.scope_label, "pairs": 0,
               "median_nn_m": round(facts.local_graph_threshold_m / 1.5, 1) if facts.local_graph_threshold_m else 0,
               "local_threshold_m": round(facts.local_graph_threshold_m, 1),
               "redundant": len(facts.redundant_feature_ids),
               "critical": len(facts.needed_locations)},
            redundant_feature_ids=facts.redundant_feature_ids,
            needed_feature_ids=facts.needed_feature_ids,
            needed_locations=[{"id": loc.id, "lon": loc.lon, "lat": loc.lat, "reason": loc.reason} for loc in facts.needed_locations],
        )

    crib = _spacing_crib_sheet(facts)
    narrative_prompt = (
        "The FACTS below are real, pre-computed distances between "
        f"`{body.category}` features that are closer together than "
        f"{body.distance_m:.0f} m. The red/green recommendation counts are "
        "computed separately from conservative duplicate/service-gap rules, "
        "not from the full report threshold. Using ONLY the FACTS, write a "
        "short markdown section:\n\n"
        "`## Assessment` — 2-4 sentences on whether the clustering looks "
        "like genuine redundancy worth consolidating, citing the real "
        "cluster sizes, distances, and red/green recommendation counts "
        "from FACTS.\n\n"
        "`## Recommendation` — a short numbered list of concrete next "
        "steps (e.g. field-verify before removal, check for a physical "
        "reason like a road crossing or a junction).\n\n"
        "CRITICAL RULE: never state a distance, count, or feature name "
        "that is not written verbatim in FACTS below.\n\n"
        f"FACTS:\n{crib}"
    )
    reply = await run_grounded_completion(
        context=crib,
        user_prompt=narrative_prompt,
        num_predict=500,
        num_ctx=2048,
    )

    return AiAnswer(
        kind="spacing",
        model=reply.model,
        prompt_tokens_hint=reply.prompt_tokens_hint,
        context_rows=facts.total_in_scope,
        grounded=True,
        answer_markdown=f"{facts_markdown}\n\n{reply.text}",
        generated_at=datetime.now(timezone.utc),
        debug={"scope": facts.scope_label, "pairs": len(facts.pairs),
               "median_nn_m": round(facts.local_graph_threshold_m / 1.5, 1) if facts.local_graph_threshold_m else 0,
               "local_threshold_m": round(facts.local_graph_threshold_m, 1),
               "redundant": len(facts.redundant_feature_ids),
               "critical": len(facts.needed_locations)},
        redundant_feature_ids=facts.redundant_feature_ids,
        needed_feature_ids=facts.needed_feature_ids,
            needed_locations=[{"id": loc.id, "lon": loc.lon, "lat": loc.lat, "reason": loc.reason} for loc in facts.needed_locations],
    )


# ---------------------------------------------------------------------------
# AI Manhole Recommendation Engine — real connectivity/road-graph facts from
# app.services.manhole_recommend; this endpoint only formats those facts for
# Ollama to narrate (never to compute) and assembles the response, same
# discipline as the spatial audit engine's /explain below.
# ---------------------------------------------------------------------------
def _route_out(
    route: PipeRoute, elevation_source: str | None = None, flow_confirmed: bool | None = None,
    rainy_season_closed: bool | None = None, route_basis: str | None = None,
) -> PipeRouteOut:
    return PipeRouteOut(
        from_id=route.from_id,
        to_id=route.to_id,
        coordinates=[[lon, lat] for lon, lat in route.coordinates],
        pipe_spec=PipeSpecOut(
            material=route.pipe_spec.material,
            diameter_mm=route.pipe_spec.diameter_mm,
            from_rl=route.pipe_spec.from_rl,
            to_rl=route.pipe_spec.to_rl,
            slope=route.pipe_spec.slope,
        ),
        elevation_source=elevation_source,
        flow_confirmed=flow_confirmed,
        rainy_season_closed=rainy_season_closed,
        route_basis=route_basis,
    )


def _feature_fact_sheet(rec: FeatureRecommendation) -> str:
    p = rec.parsed
    lines = [
        f"MANHOLE_ID: {rec.manhole_id}",
        f"LOCATION: lon={rec.lon:.6f}, lat={rec.lat:.6f}",
        f"PROBLEM_TYPE: {rec.problem_type}",
        f"REASON (verified, not an estimate): {rec.reason}",
        f"Surveyed condition: {p.condition or 'not recorded'}",
        f"Surveyed top level (RL): {p.top_level_m if p.top_level_m is not None else (p.raw_top_level or 'not recorded')}",
        f"Surveyed bottom level (RL): {p.bottom_level_m if p.bottom_level_m is not None else 'not recorded'}",
        f"Surveyed pipe type: {p.pipe_type or 'not recorded'}",
        f"Surveyed diameter: {p.diameter_mm} mm" if p.diameter_mm is not None else "Surveyed diameter: not recorded",
        f"Nearest drain distance: {rec.nearest_drain_distance_m:.1f} m" if rec.nearest_drain_distance_m is not None else "Nearest drain distance: none found",
    ]
    if p.raw_silt_level and p.raw_silt_level.lower() != "no":
        lines.append(f"Silt level recorded at {p.raw_silt_level} — siltation present, not just a clear pipe")
    if rec.route:
        spec = rec.route.pipe_spec
        lines.append(
            f"RECOMMENDED PIPE: material={spec.material}, diameter={spec.diameter_mm:.0f} mm"
            + (f", from_rl={spec.from_rl}, to_rl={spec.to_rl}" if spec.from_rl is not None else "")
            + (f", slope={spec.slope}" if spec.slope is not None else ", slope=not computable (chord too short)")
        )
        lines.append(f"Route length: {len(rec.route.coordinates)} vertices, confirmed clear of every Building polygon")
    return "\n".join(lines)


def _area_fact_sheet(disconnected: list, gaps: list[dict], bad: list | None = None) -> str:
    bad = bad or []
    lines = [
        f"MANHOLES_NEEDING_REHABILITATION: {len(bad)}",
        f"DISCONNECTED_MANHOLES: {len(disconnected)}",
        f"DRAIN_COVERAGE_GAPS: {len(gaps)}",
    ]
    for issue in bad[:20]:
        lines.append(f"  - manhole {issue.manhole_id} ({issue.problem_type}): {issue.reason}")
    for issue in disconnected[:15]:
        lines.append(f"  - manhole {issue.manhole_id}: {issue.reason}")
    for gap in gaps[:15]:
        dist = gap.get("nearest_manhole_m")
        lines.append(
            f"  - gap at lon={gap['lon']:.6f}, lat={gap['lat']:.6f}: "
            + (f"nearest manhole {dist:.0f} m away" if dist is not None else "no manhole found nearby")
        )
    return "\n".join(lines)


_ELEVATION_SOURCE_LABEL = {
    "surveyed_invert": "real surveyed invert level",
    "surveyed_top_minus_depth": "surveyed top level minus surveyed depth",
    "surveyed_top_level": "surveyed top level (no depth on file)",
    "dtm_raster": "sampled from the real DTM terrain model",
    "nearest_contour": "nearest surveyed contour line",
    "unknown": "no elevation data available",
}


async def _manhole_network_response(dataset_id: uuid.UUID, model: str, db: AsyncSession) -> AiAnswer:
    """`network` mode: the complete manhole-to-manhole drainage layout,
    not just the problem manholes — every edge is road/sewage-line-routed
    and verified clear of every Building, with flow direction grounded in
    real elevation (see build_full_network's docstring for the exact
    source priority). Skips the LLM call entirely: with up to ~80 edges
    this is fundamentally a structured data dump, and Ollama would only be
    asked to restate counts already computed here — the same reasoning
    that already skips the LLM for the empty-scope area-mode response."""
    edges, unconnected, outfall_ids = await build_full_network(dataset_id, db)
    confirmed = [e for e in edges if e.flow_confirmed]
    routed = [e for e in edges if e.route]
    sewage_routed = [e for e in routed if e.route_basis == "sewage_line"]
    road_routed = [e for e in routed if e.route_basis == "concrete_road"]
    bridge_routed = [e for e in routed if e.route_basis == "bridge"]
    connected_manhole_ids = {e.from_id for e in edges} | {e.to_id for e in edges}
    total_manholes = len(connected_manhole_ids) + len(unconnected)
    by_source: dict[str, int] = {}
    for e in edges:
        by_source[e.elevation_source] = by_source.get(e.elevation_source, 0) + 1

    if not edges and not unconnected:
        return AiAnswer(
            kind="manhole_recommend", model=model, prompt_tokens_hint=0, context_rows=0,
            grounded=True,
            answer_markdown="No manholes found in this dataset to build a network from.",
            generated_at=datetime.now(timezone.utc), debug={"edges": 0},
        )

    source_lines = "\n".join(
        f"- {_ELEVATION_SOURCE_LABEL.get(src, src)}: {count} manhole(s)" for src, count in sorted(by_source.items())
    )
    outfall_lines = "\n".join(f"- `{oid}`" for oid in outfall_ids) or "- none (no manhole elevation data available)"
    answer_markdown = (
        f"## Full Drainage Network\n\n"
        f"**{len(connected_manhole_ids)} of {total_manholes}** manholes are connected to their real nearest "
        f"downstream neighbour, linked by **{len(edges)}** segments — each one following the actual sewage/drain "
        f"pipe or road, never a straight line between two manholes that just happen to be nearby, and never "
        f"skipping past a real intermediate manhole without connecting to it first. Every connection prefers a "
        f"downhill neighbour over a merely-nearer one, so chains trend toward the ward's real lowest points "
        f"instead of many disconnected local pairs.\n\n"
        f"### Master outfalls (the {len(outfall_ids)} real lowest manholes — everything drains toward these)\n"
        f"{outfall_lines}\n\n"
        f"- **{len(sewage_routed)}** segments follow a real, directly-surveyed sewage/drain pipe.\n"
        f"- **{len(road_routed)}** segments had no sewage-pipe path (a digitization gap in that layer) and instead "
        f"follow the concrete road network as a stated assumption — real sewage pipes run alongside/beneath roads "
        f"almost everywhere, but this is an inferred path, not a directly-surveyed one.\n"
        + f"- **{len(confirmed)} of {len(edges)}** connections have a flow direction confirmed by real elevation data "
        f"(high → low is a genuine, evidenced fact here, not an assumption).\n"
        f"- **{len(edges) - len(confirmed)}** connections are drawn but have **no confirmed flow direction** — "
        f"neither end had usable elevation data, so no direction is asserted.\n"
        f"- **{len(unconnected)} of {total_manholes}** manholes are **not connected** to either network — no real "
        f"sewage pipe or concrete road was found within reach, so no route is drawn for them at all rather than a "
        f"fabricated connection.\n\n"
        f"### Elevation source used per manhole\n{source_lines}\n"
    )

    return AiAnswer(
        kind="manhole_recommend", model=model, prompt_tokens_hint=0, context_rows=len(edges), grounded=True,
        answer_markdown=answer_markdown,
        generated_at=datetime.now(timezone.utc),
        debug={
            "edges": len(edges), "connected_manholes": len(connected_manhole_ids),
            "flow_confirmed": len(confirmed), "routed": len(routed),
            "sewage_routed": len(sewage_routed), "road_routed": len(road_routed), "bridge_routed": len(bridge_routed),
            "unconnected": len(unconnected), "by_elevation_source": by_source,
            "outfall_ids": outfall_ids,
        },
        routes=[
            _route_out(e.route, e.elevation_source, e.flow_confirmed, e.rainy_season_closed, e.route_basis)
            for e in edges if e.route
        ],
        unconnected_manholes=[
            {"id": u.manhole_id, "lon": u.lon, "lat": u.lat, "reason": u.reason} for u in unconnected
        ],
    )


@router.post(
    "/manhole-recommend",
    response_model=AiAnswer,
    dependencies=[Depends(require_any)],
    summary="Recommend a fix for one manhole, or scan a whole dataset for disconnected manholes/coverage gaps",
)
async def manhole_recommend(body: ManholeRecommendRequest, db: AsyncSession = Depends(get_db)) -> AiAnswer:
    from app.core.config import get_settings
    model = get_settings().ollama_model

    if body.mode == "feature":
        if body.feature_id is None:
            raise HTTPException(status_code=400, detail="feature_id is required for mode=feature")
        rec = await build_feature_recommendation(body.dataset_id, body.feature_id, db)
        if rec is None:
            return _insufficient("manhole_recommend", model, {"reason": "manhole not found in this dataset"})

        crib = _feature_fact_sheet(rec)
        routes_out = [_route_out(rec.route)] if rec.route else []

        if rec.problem_type == "ok":
            # Nothing to recommend — state the real facts, skip the LLM call
            # entirely (there's no ambiguity for it to narrate around).
            return AiAnswer(
                kind="manhole_recommend", model=model, prompt_tokens_hint=0, context_rows=1,
                grounded=True, answer_markdown=f"**No issue found.** {rec.reason}.",
                generated_at=datetime.now(timezone.utc), debug={"problem_type": rec.problem_type},
                routes=routes_out,
            )

        prompt = (
            "You are a senior municipal drainage engineer writing a finding "
            "note for a field team. Using ONLY the FACTS below, write 3-5 "
            "sentences: (1) what is wrong with this manhole, citing the exact "
            "reason and any levels/condition given, (2) why it matters "
            "practically (blockage, overflow, structural risk), (3) the exact "
            "recommended pipe material/diameter/slope from FACTS if present. "
            "Never state a number not in FACTS, and never invent a location "
            "beyond the one given.\n\nFACTS:\n" + crib
        )
        reply = await run_grounded_completion(context=crib, user_prompt=prompt, num_predict=260, num_ctx=1024)
        return AiAnswer(
            kind="manhole_recommend", model=reply.model, prompt_tokens_hint=reply.prompt_tokens_hint,
            context_rows=1, grounded=True, answer_markdown=reply.text,
            generated_at=datetime.now(timezone.utc),
            debug={"problem_type": rec.problem_type, "nearest_drain_distance_m": rec.nearest_drain_distance_m},
            routes=routes_out,
            needed_locations=[] if rec.problem_type != "disconnected" else [
                {"id": rec.manhole_id, "lon": rec.lon, "lat": rec.lat, "reason": rec.reason}
            ],
            redundant_feature_ids=[rec.manhole_id] if rec.problem_type in ("bad_condition", "blocked") else [],
        )

    if body.mode == "network":
        return await _manhole_network_response(body.dataset_id, model, db)

    # mode == "area": scan EVERY manhole for real, grounded problems
    # (blocked / bad condition / disconnected) and build a route for each —
    # a single click must surface all bad manholes, not just one line.
    recs = await scan_all_manhole_recommendations(body.dataset_id, db)
    disconnected = [r for r in recs if r.problem_type == "disconnected"]
    bad = [r for r in recs if r.problem_type in ("blocked", "bad_condition")]
    rehabilitation_routes = [r.route for r in recs if r.route]
    gaps = await find_coverage_gaps(body.dataset_id, db)
    scope_count = len(disconnected) + len(gaps) + len(bad)

    crib = _area_fact_sheet(disconnected, gaps, bad)
    facts_markdown = (
        f"## Ward-wide Manhole Network Check\n\n"
        f"- Manholes needing rehabilitation (blocked / bad condition): **{len(bad)}**\n"
        f"- Disconnected manholes (no drain within range): **{len(disconnected)}**\n"
        f"- Drain coverage gaps (roadside, no manhole nearby): **{len(gaps)}**\n"
    )

    if scope_count == 0:
        return AiAnswer(
            kind="manhole_recommend", model=model, prompt_tokens_hint=0, context_rows=0,
            grounded=True,
            answer_markdown=facts_markdown + "\nNo disconnected manholes, blocked/bad-condition manholes, or drain coverage gaps were found — the surveyed network in this dataset is fully connected and in good condition.",
            generated_at=datetime.now(timezone.utc), debug={"disconnected": 0, "gaps": 0, "bad": 0},
        )

    prompt = (
        "Using ONLY the FACTS below (a real, pre-computed scan of a "
        "municipal drainage network), write a short `## Assessment` (2-3 "
        "sentences on the overall network health, noting how many manholes "
        "need rehabilitation vs are disconnected) and `## Priority Actions` "
        "(a numbered list of the most urgent items, citing exact manhole "
        "ids/coordinates from FACTS). Never invent a location or count not "
        "in FACTS.\n\nFACTS:\n" + crib
    )
    reply = await run_grounded_completion(context=crib, user_prompt=prompt, num_predict=400, num_ctx=2048)

    return AiAnswer(
        kind="manhole_recommend", model=reply.model, prompt_tokens_hint=reply.prompt_tokens_hint,
        context_rows=scope_count, grounded=True,
        answer_markdown=f"{facts_markdown}\n\n{reply.text}",
        generated_at=datetime.now(timezone.utc),
        debug={"disconnected": len(disconnected), "gaps": len(gaps), "bad": len(bad), "routes": len(rehabilitation_routes)},
        routes=[_route_out(r) for r in rehabilitation_routes],
        needed_locations=[
            {"id": f"gap-{i}", "lon": g["lon"], "lat": g["lat"], "reason": "Drain coverage gap"}
            for i, g in enumerate(gaps)
        ] + [
            {"id": r.manhole_id, "lon": r.lon, "lat": r.lat, "reason": r.reason}
            for r in disconnected
        ],
        redundant_feature_ids=[r.manhole_id for r in disconnected] + [r.manhole_id for r in bad],
    )


# ---------------------------------------------------------------------------
# Spatial Audit Engine (Phase 1) — pole redundancy, drain encroachment,
# manhole status. All geometry math lives in app.services.spatial_audit;
# these endpoints only run it, persist/read results, and (lazily) narrate
# a single finding via the same anti-hallucination run_grounded_completion
# used everywhere else in this file.
# ---------------------------------------------------------------------------
def _anomaly_fact_sheet(row: SpatialAnomaly) -> str:
    """Turn one SpatialAnomaly's raw `anomaly_metadata` into a labeled,
    human-readable fact sheet for the LLM — a Python dict repr is harder
    for a small local model to quote accurately than plain labeled lines."""
    m = row.anomaly_metadata
    lines = [
        f"ANOMALY_TYPE: {row.anomaly_type.value}",
        f"COLOR: {row.color.value}",
        f"SEVERITY_SCORE_0_100: {row.severity_score:.0f}",
        f"WARD: {row.ward or 'unknown'}",
    ]

    if row.anomaly_type.value == "drain_encroachment":
        crosses = bool(m.get("drain_crosses_building"))
        lines += [
            "The building genuinely touches the drain's raw centerline (verified geometrically — a real shared point, not an estimate or a buffer)."
            ,
            f"The drain runs {m.get('drain_chord_length_m')} m through this building's interior, which is {m.get('crossing_ratio_pct')}% of the building's own average width ({m.get('building_span_m')} m) — "
            + ("this is a FULL CROSSING: the drain runs most/all of the way across the building, entering one side and exiting the other." if crosses
               else "this is a PARTIAL CLIP: the drain only cuts through a fraction of the building (a corner or an edge), not the whole structure."),
            f"Estimated encroached area, assuming a {m.get('drain_buffer_m')} m channel half-width either side of the drain centerline: {m.get('overlap_area_m2')} m^2 ({m.get('overlap_pct')}% of this building's {m.get('building_area_m2')} m^2 footprint) — this area figure is illustrative of scale, the chord length/ratio above is the exact finding",
            f"Drain category/categories involved: {m.get('drain_categories')}",
        ]
    elif row.anomaly_type.value == "pole_redundancy":
        if row.color.value == "green":
            lines += [
                f"This pole was kept as the representative asset for a cluster of {m.get('cluster_size')} closely-spaced poles.",
                f"Category: {m.get('this_category')}",
            ]
        elif row.color.value == "red":
            lines += [
                f"This pole sits in a cluster of {m.get('cluster_size')} poles within {m.get('eps_m')} m of each other — redundant.",
                f"Category: {m.get('this_category')}; the pole kept instead was category {m.get('kept_category')}",
            ]
        else:
            lines += [
                f"Nearest same-family pole is {m.get('nearest_neighbor_m')} m away — inside the {m.get('yellow_band_m')} m borderline band but not tight enough to count as a redundant cluster (threshold {m.get('eps_m')} m).",
            ]
    elif row.anomaly_type.value == "manhole_status":
        sewage_line = (
            "CONNECTED to a real surveyed sewage line" if m.get("connected_to_sewage")
            else "NOT connected to a sewage line (nearest drain is not a sewage line — confirmed from real GIS data, not assumed)"
        )
        lines += [
            f"Basis for this finding (the actual real evidence used, verified not estimated): {m.get('basis')}",
            f"Surveyed condition on file: {m.get('surveyed_condition') or 'not recorded'}",
            f"Nearest drain: {m.get('nearest_drain_category') or 'none found'}, {m.get('nearest_drain_distance_m')} m away (search radius {m.get('max_search_radius_m')} m).",
            f"Sewage line connectivity: this manhole is {sewage_line}.",
        ]
        if m.get("primary_issue"):
            lines.append(f"Classified issue: {m.get('primary_issue')} (severity hint: {m.get('severity_hint') or 'unknown'}).")
    elif row.anomaly_type.value == "powerline_proximity":
        tier_label = {
            "red": "CRITICAL — inside the danger clearance band",
            "yellow": "MARGINAL — closer than the safe-clearance threshold but not yet critical",
            "green": "CONFIRMED OK — real clearance from the nearest power line",
        }.get(row.color.value, "unclassified")
        lines += [
            f"Basis for this finding (the actual real evidence used, verified not estimated): {m.get('basis')}",
            f"Building is {m.get('nearest_powerline_distance_m')} m from the nearest power line.",
            f"Clearance thresholds — critical: <= {m.get('red_threshold_m')} m, marginal: <= {m.get('yellow_threshold_m')} m, danger clearance: {m.get('danger_threshold_m')} m.",
            f"Classification: {tier_label}.",
            f"Building height (surveyed): {m.get('building_height_m') if m.get('building_height_m') is not None else 'not recorded'} m.",
            f"Nearest power line conductor height: {m.get('nearest_pole_height_m')} m (from the nearest real pole; default assumed if no pole survey point was found nearby).",
            f"Power line category/categories involved: {m.get('powerline_categories')}",
        ]
    elif row.anomaly_type.value == "pothole_status":
        lines += [
            f"Mapped pothole area: {m.get('area_sqm') if m.get('area_sqm') is not None else 'not recorded'} m².",
            f"Measured/calculated depth: {m.get('depth_cm') if m.get('depth_cm') is not None else 'not available'} cm.",
            f"Estimated repair volume: {m.get('estimated_repair_volume_m3') if m.get('estimated_repair_volume_m3') is not None else 'not available'} m³.",
            f"Severity basis: {', '.join(m.get('reasons') or []) or 'mapped pothole evidence'}.",
        ]
    elif row.anomaly_type.value == "standing_water_status":
        lines += [
            f"Mapped standing-water area: {m.get('area_sqm') if m.get('area_sqm') is not None else 'not recorded'} m².",
            f"Road intersection: {bool(m.get('intersects_road'))}; nearest road distance: {m.get('nearest_road_distance_m')} m.",
            f"Drain intersection: {bool(m.get('intersects_drain'))}; nearest drain distance: {m.get('nearest_drain_distance_m')} m.",
            f"Severity basis: {', '.join(m.get('reasons') or []) or 'mapped standing-water evidence'}.",
        ]

    return "\n".join(lines)


def _anomaly_out(row: SpatialAnomaly, lon: float, lat: float) -> SpatialAnomalyOut:
    return SpatialAnomalyOut(
        id=row.id,
        dataset_id=row.dataset_id,
        ward=row.ward,
        anomaly_type=row.anomaly_type.value,
        color=row.color.value,
        severity_score=row.severity_score,
        status=row.status.value,
        lon=lon,
        lat=lat,
        feature_ids=list(row.feature_ids),
        anomaly_metadata=row.anomaly_metadata,
        explanation_text=row.explanation_text,
        created_at=row.created_at,
    )


@router.post(
    "/audit",
    response_model=AuditRunResponse,
    dependencies=[Depends(require_any)],
    summary="Run the spatial audit engine for poles, drains, manholes, roads, potholes, and standing water",
)
async def run_audit(body: AuditRunRequest, db: AsyncSession = Depends(get_db)) -> AuditRunResponse:
    try:
        summary = await run_spatial_audit(body.dataset_id, db)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    ward_row = (
        await db.execute(
            select(SpatialAnomaly.ward).where(SpatialAnomaly.dataset_id == body.dataset_id).limit(1)
        )
    ).scalar_one_or_none()

    return AuditRunResponse(
        dataset_id=body.dataset_id,
        ward=ward_row,
        pole_redundancy=summary.pole_redundancy,
        drain_encroachment=summary.drain_encroachment,
        manhole_status=summary.manhole_status,
        road_width_narrowing=summary.road_width_narrowing,
        powerline_proximity=summary.powerline_proximity,
        pothole_status=summary.pothole_status,
        standing_water_status=summary.standing_water_status,
    )


@router.get(
    "/audit/anomalies",
    response_model=list[SpatialAnomalyOut],
    dependencies=[Depends(require_any)],
    summary="List persisted spatial audit findings as map-ready points",
)
async def list_anomalies(
    dataset_id: uuid.UUID,
    status_filter: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> list[SpatialAnomalyOut]:
    stmt = (
        select(SpatialAnomaly, func.ST_X(SpatialAnomaly.geom), func.ST_Y(SpatialAnomaly.geom))
        .where(SpatialAnomaly.dataset_id == dataset_id)
    )
    if status_filter:
        stmt = stmt.where(SpatialAnomaly.status == status_filter)
    rows = (await db.execute(stmt)).all()
    return [_anomaly_out(row, lon, lat) for row, lon, lat in rows]


@router.get(
    "/audit/roads/{road_id}",
    response_model=RoadInspectionOut,
    dependencies=[Depends(require_any)],
    summary="List unresolved spatial-audit findings for one surveyed road centerline",
)
async def inspect_road(
    road_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> RoadInspectionOut:
    report = await build_road_inspection(road_id, db)
    if report is None:
        raise HTTPException(status_code=404, detail="Road centerline not found")
    return RoadInspectionOut.model_validate(report)


async def _manhole_pipe_suggestion_facts(row: SpatialAnomaly, db: AsyncSession) -> str | None:
    """Same-manhole-only pipe material/diameter suggestion, grounded in
    THIS manhole's own surveyed Pipe_Type/Diameter attributes — no routing,
    no other manhole or drain involved (that connectivity engine was
    removed once real Sewage Line data made it unnecessary). Only relevant
    for a real or borderline finding; a green (no-problem) manhole gets no
    suggestion since there's nothing to fix."""
    if row.color.value == "green":
        return None

    manhole_id = row.anomaly_metadata.get("manhole_id")
    if not manhole_id:
        return None
    feature = (
        await db.execute(select(Feature).where(Feature.id == uuid.UUID(manhole_id)))
    ).scalar_one_or_none()
    if feature is None:
        return None
    spec = recommend_pipe_spec(feature.attributes or {})
    if spec is None:
        return None
    material, diameter_mm, existing_diameter_mm = spec
    lines = [
        "PIPE_SUGGESTION (real, computed from this manhole's own surveyed attributes — cite these exact values):",
        f"  material: {material}",
        f"  diameter_mm: {diameter_mm:.0f}",
    ]
    if existing_diameter_mm is not None:
        lines.append(f"  existing_surveyed_diameter_mm: {existing_diameter_mm:.0f}")
    else:
        lines.append("  existing_surveyed_diameter_mm: not recorded (smallest standard size proposed)")
    return "\n".join(lines)


def _manhole_status_explain_prompt(row: SpatialAnomaly, crib: str) -> str:
    """manhole_status gets its own structured prompt (Issue / Required /
    How to fix) rather than the generic drain/pole one below — the generic
    prompt's "why it matters" + "one recommendation" framing assumes a
    problem exists, which reads fine for a confirmed red finding but
    produces vague or invented text for yellow (ambiguous) and green (no
    problem at all) manholes. Each color gets guidance matched to what kind
    of answer is actually correct for it."""
    color = row.color.value
    if color == "red":
        guidance = (
            "This manhole has a CONFIRMED problem. Answer in exactly three labeled "
            "parts on their own lines: 'Issue:' (the exact problem from FACTS — quote "
            "the real condition/level/distance figures given), 'Required:' (what must "
            "be done — desilting, cover/frame replacement, structural repair, or "
            "pipe replacement, whichever fits FACTS), and 'How to fix:' (the concrete "
            "field steps an engineer or contractor would take, in order). If FACTS "
            "includes a PIPE_SUGGESTION, your 'How to fix:' MUST cite that exact "
            "material and diameter as the pipe to use for any replacement — never "
            "invent a different size or material."
        )
    elif color == "yellow":
        guidance = (
            "This manhole shows a BORDERLINE finding, not a confirmed failure. Answer "
            "in exactly three labeled parts on their own lines: 'Issue:' (state exactly "
            "what makes this borderline, quoting the real figures from FACTS), "
            "'Required:' (what should be checked or monitored — typically a field "
            "inspection to confirm actual condition), and 'How to fix:' (the "
            "preventive/monitoring step to take now so this does not become a red "
            "finding). If FACTS includes a PIPE_SUGGESTION, mention it in 'How to "
            "fix:' as the pipe already identified for this manhole should it need "
            "replacement later."
        )
    else:
        guidance = (
            "This manhole shows NO problem — it is in good working order per the real "
            "evidence. Answer in exactly three labeled parts on their own lines: "
            "'Issue:' (state plainly that no issue was found, citing the specific real "
            "evidence from FACTS that confirms this — do not invent a problem), "
            "'Required:' (say 'No action required' unless FACTS itself shows a real "
            "caveat), and 'How to fix:' (state the routine maintenance/inspection "
            "interval appropriate for a healthy manhole — not a fix for a problem that "
            "does not exist)."
        )
    return (
        "You are a senior municipal infrastructure auditor writing a finding note for "
        "a civil engineer who will act on it. Using ONLY the FACTS below, and never a "
        "number or detail not present in FACTS, write the note. Never mention that you "
        "were given 'facts' or metadata — just report the finding. Always state this "
        "manhole's sewage line connectivity plainly as part of 'Issue:' — if FACTS says "
        "it is NOT connected to a sewage line, say exactly that ('not connected to the "
        "sewage line'), never omit it or soften it into something vaguer. " + guidance + "\n\n"
        f"FACTS:\n{crib}"
    )


def _powerline_proximity_explain_prompt(row: SpatialAnomaly, crib: str) -> str:
    """powerline_proximity gets its own structured prompt (Issue / Required /
    How to fix), same shape as manhole_status — otherwise the generic
    drain/pole prompt's "one recommendation" framing tends to default to
    the most drastic-sounding fix (demolish/relocate the building) instead
    of the actual standard electrical-safety remedy, which is almost always
    insulating or rerouting the LINE, not moving the structure. Each color
    gets guidance matched to what kind of answer is actually correct."""
    color = row.color.value
    if color == "red":
        guidance = (
            "This building has a CONFIRMED critical clearance violation from a power "
            "line. Answer in exactly three labeled parts on their own lines: 'Issue:' "
            "(the exact clearance figures from FACTS — distance, threshold, conductor "
            "height), 'Required:' (what the electricity board / line owner must do to "
            "make this safe), and 'How to fix:' (the concrete field remedy). The "
            "correct standard remedy for a bare overhead conductor too close to a "
            "structure is, in order of preference: (1) the electricity board raises "
            "or reroutes the line to restore clearance, (2) the exposed conductor "
            "section is replaced with insulated/covered cable (e.g. XLPE-insulated "
            "aerial bunched cable) so incidental contact is not a shock hazard, or "
            "(3) if it is a low-voltage service line, it is re-run through rigid "
            "PVC/HDPE conduit. Relocating or demolishing the building is NOT the "
            "standard remedy and must NOT be recommended unless FACTS explicitly "
            "shows the clearance cannot be restored by any line-side fix — do not "
            "suggest it by default. Also state plainly that nobody should touch the "
            "structure's roof/terrace or any metal fixture near the line until the "
            "line owner has insulated or restored clearance."
        )
    elif color == "yellow":
        guidance = (
            "This building shows a MARGINAL clearance from a power line, not a "
            "confirmed violation. Answer in exactly three labeled parts on their own "
            "lines: 'Issue:' (state exactly what makes this marginal, quoting the "
            "real distance/threshold figures from FACTS), 'Required:' (a field "
            "verification of the actual conductor height and clearance, since the "
            "surveyed pole height may be a default estimate), and 'How to fix:' (the "
            "preventive step — request the electricity board confirm clearance, and "
            "advise against any new construction, scaffolding, or antenna/rooftop "
            "work on this building that would reduce the clearance further). Do not "
            "recommend relocating the building for a marginal finding."
        )
    else:
        guidance = (
            "This building shows NO clearance problem — it is a real, confirmed safe "
            "distance from the nearest power line. Answer in exactly three labeled "
            "parts on their own lines: 'Issue:' (state plainly that no clearance "
            "issue was found, citing the real distance and threshold from FACTS), "
            "'Required:' (say 'No action required' unless FACTS itself shows a real "
            "caveat), and 'How to fix:' (state that no remedy is needed; only advise "
            "that any future rooftop addition on this building should not encroach "
            "on the existing clearance)."
        )
    return (
        "You are a senior electrical-safety and municipal infrastructure auditor "
        "writing a finding note for a civil engineer who will act on it. Using ONLY "
        "the FACTS below, and never a number or detail not present in FACTS, write "
        "the note. Never mention that you were given 'facts' or metadata — just "
        "report the finding. " + guidance + "\n\n"
        f"FACTS:\n{crib}"
    )


@router.post(
    "/audit/anomalies/{anomaly_id}/explain",
    response_model=AnomalyExplainResponse,
    dependencies=[Depends(require_any)],
    summary="Get (or lazily generate) a plain-English explanation for one specific finding",
)
async def explain_anomaly(anomaly_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AnomalyExplainResponse:
    row = (
        await db.execute(select(SpatialAnomaly).where(SpatialAnomaly.id == anomaly_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Anomaly not found")

    if row.explanation_text:
        return AnomalyExplainResponse(
            id=row.id,
            explanation_text=row.explanation_text,
            explanation_model=row.explanation_model or "",
            cached=True,
        )

    crib = _anomaly_fact_sheet(row)
    if row.anomaly_type.value == "manhole_status":
        pipe_facts = await _manhole_pipe_suggestion_facts(row, db)
        if pipe_facts:
            crib = f"{crib}\n{pipe_facts}"
        prompt = _manhole_status_explain_prompt(row, crib)
    elif row.anomaly_type.value == "powerline_proximity":
        prompt = _powerline_proximity_explain_prompt(row, crib)
    else:
        prompt = (
            "You are a senior municipal infrastructure auditor writing a finding "
            "note for a civil engineer who will act on it. Using ONLY the FACTS "
            "below, write 3-5 sentences covering, in order: (1) exactly what was "
            "found, citing the specific percentage/distance/count figures given, "
            "(2) why it matters in practical civic terms (drainage flow, fire "
            "access, over-illumination cost, etc.), and (3) one concrete, "
            "actionable recommendation. Be direct and precise, not vague — write "
            "like an expert who has personally verified these numbers, not a "
            "chatbot hedging. Never state a number that is not present in FACTS, "
            "and never mention that you were given 'facts' or metadata — just "
            "report the finding. If FACTS says the drain's centerline crosses "
            "straight through the building, your very first sentence must say "
            "so plainly (e.g. 'the drain runs directly through this building') "
            "before any percentage — the crossing itself is the headline, the "
            "percentage is supporting detail, never the other way around. If "
            "FACTS gives an encroached/overlapping area in square meters, you "
            "MUST state that exact area figure (not just the percentage) "
            "somewhere in the finding — engineers need the physical area, not "
            "only a ratio.\n\n"
            f"FACTS:\n{crib}"
        )
    reply = await run_grounded_completion(context=crib, user_prompt=prompt, num_predict=280, num_ctx=1024)

    row.explanation_text = reply.text
    row.explanation_model = reply.model
    await db.commit()

    return AnomalyExplainResponse(
        id=row.id, explanation_text=reply.text, explanation_model=reply.model, cached=False
    )


@router.patch(
    "/audit/anomalies/{anomaly_id}",
    response_model=SpatialAnomalyOut,
    summary="Update a finding's non-approval review status",
)
async def update_anomaly_status(
    anomaly_id: uuid.UUID,
    body: AnomalyStatusUpdate,
    user: User = Depends(require_any),
    db: AsyncSession = Depends(get_db),
) -> SpatialAnomalyOut:
    row = (
        await db.execute(select(SpatialAnomaly).where(SpatialAnomaly.id == anomaly_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Anomaly not found")

    requested_status = AnomalyStatus(body.status)
    if requested_status == AnomalyStatus.RESOLVED:
        raise HTTPException(
            status_code=409,
            detail="An AI finding can be resolved only through Architect evidence and Admin approval",
        )
    if user.role == UserRole.ARCHITECT and requested_status not in {AnomalyStatus.OPEN, AnomalyStatus.REVIEWING}:
        raise HTTPException(status_code=403, detail="Architects may only open or mark a finding as reviewing")

    row.status = requested_status
    await db.commit()
    await db.refresh(row)

    lon, lat = (
        await db.execute(
            select(func.ST_X(SpatialAnomaly.geom), func.ST_Y(SpatialAnomaly.geom)).where(
                SpatialAnomaly.id == anomaly_id
            )
        )
    ).one()
    return _anomaly_out(row, lon, lat)

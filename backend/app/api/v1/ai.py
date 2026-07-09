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
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db
from app.schemas.ai import (
    AiAnswer,
    NLQueryRequest,
    RecommendRequest,
    ReportRequest,
)
from app.services.ai import (
    AI_DISCLAIMER,
    INSUFFICIENT_ANSWER,
    run_grounded_completion,
)
from app.services.ai_context import (
    ReportFacts,
    build_dataset_or_ward_context,
    build_feature_ids_context,
    build_recommend_context,
    build_report_facts,
)

log = logging.getLogger("davangere.api.ai")
router = APIRouter()


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
    return (
        f"SCOPE: {facts.scope_label}\n"
        f"TOTAL_FEATURES: {facts.total_features}\n"
        f"DISTINCT_CATEGORIES: {facts.distinct_categories}\n"
        f"TOP_CATEGORIES (real name and count — do not invent any other category name): {top_categories}\n"
        f"SEVERITY_BUCKETS: high={facts.severity_buckets['high']}, "
        f"medium={facts.severity_buckets['medium']}, low={facts.severity_buckets['low']}\n"
        f"REVIEW_BACKLOG: {facts.review_summary}\n"
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
    if body.dataset_id is None and body.ward is None:
        raise HTTPException(status_code=400, detail="Provide either dataset_id or ward")

    from app.core.config import get_settings
    settings = get_settings()
    model = settings.ollama_model

    facts = await build_report_facts(db, dataset_id=body.dataset_id, ward=body.ward)
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
        "Using ONLY the FACTS below, write these remaining sections, using "
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

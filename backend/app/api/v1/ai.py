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
    PrioritizeRequest,
    RecommendRequest,
    SummarizeRequest,
)
from app.services.ai import (
    AI_DISCLAIMER,
    INSUFFICIENT_ANSWER,
    run_grounded_completion,
)
from app.services.ai_context import (
    build_dataset_or_ward_context,
    build_feature_ids_context,
    build_prioritize_context,
    build_recommend_context,
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


# ---------------------------------------------------------------------------
# POST /api/v1/ai/summarize
# ---------------------------------------------------------------------------
@router.post(
    "/summarize",
    response_model=AiAnswer,
    dependencies=[Depends(require_any)],
    summary="Grounded markdown summary of a dataset or ward",
)
async def summarize(body: SummarizeRequest, db: AsyncSession = Depends(get_db)) -> AiAnswer:
    if body.dataset_id is None and body.ward is None:
        raise HTTPException(status_code=400, detail="Provide either dataset_id or ward")

    from app.core.config import get_settings
    model = get_settings().ollama_model

    ctx = await build_dataset_or_ward_context(
        db,
        dataset_id=body.dataset_id,
        ward=body.ward,
        max_features=body.max_features,
    )
    if ctx.count == 0:
        return _insufficient("summarize", model, ctx.debug)

    user_prompt = (
        "Produce a structured markdown report for the scope above. Include:\n"
        "1. `## Scope` — briefly restate the scope filters.\n"
        "2. `## Volume & Severity` — number of features, average severity, category mix.\n"
        "3. `## Review Backlog` — open vs resolved counts if data is present.\n"
        "4. `## Top Hotspots` — up to 5 highest-severity features (id, label, category).\n"
        "5. `## Notable Attribute Patterns` — anything recurring in the raw attributes.\n"
        "Only cite the rows in the DATABASE CONTEXT; do not invent values."
    )
    reply = await run_grounded_completion(context=ctx.text, user_prompt=user_prompt)

    return AiAnswer(
        kind="summarize",
        model=reply.model,
        prompt_tokens_hint=reply.prompt_tokens_hint,
        context_rows=ctx.count,
        grounded=True,
        answer_markdown=reply.text,
        generated_at=datetime.now(timezone.utc),
        debug=ctx.debug,
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
            "Answer strictly from the DATABASE CONTEXT above."
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
# POST /api/v1/ai/prioritize
# ---------------------------------------------------------------------------
@router.post(
    "/prioritize",
    response_model=AiAnswer,
    dependencies=[Depends(require_any)],
    summary="Prioritize the open backlog into an action list",
)
async def prioritize(body: PrioritizeRequest, db: AsyncSession = Depends(get_db)) -> AiAnswer:
    from app.core.config import get_settings
    model = get_settings().ollama_model

    ctx = await build_prioritize_context(db, ward=body.ward, limit=body.limit)
    if ctx.count == 0:
        return _insufficient("prioritize", model, ctx.debug)

    user_prompt = (
        "You are given a list of currently open review items with their "
        "priority tier (P0 most critical … P4 least), severity, category, "
        "ward, and age in hours.\n\n"
        "Produce a prioritized action plan as a markdown table with columns: "
        "Rank | review_id | Category | Ward | Reason. Order by (priority ASC, "
        "severity DESC, age_h DESC). Cover at most the top 15 rows. "
        "Do not invent items that are not in the context. Below the table, "
        "add a `## Notes` section with one paragraph summarising what themes "
        "dominate the backlog based ONLY on the rows given."
    )
    reply = await run_grounded_completion(context=ctx.text, user_prompt=user_prompt)

    return AiAnswer(
        kind="prioritize",
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

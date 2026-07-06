"""
Grounded context assembly for the Ollama RAG loop.

Every helper here returns two things:
  * `text` — the serialized, deterministic block that gets injected into
    the LLM's system prompt (never the raw markup the user typed).
  * `count` — the number of real database rows that fed the context.

`count == 0` is the trigger the endpoint layer uses to short-circuit and
return the mandatory "Sufficient local survey data is not available…"
answer *without* ever calling the model.  This is the guarantee that we
never hallucinate: no context, no LLM invocation.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(slots=True)
class GroundedContext:
    text: str
    count: int
    debug: dict[str, Any]


def _fmt_attrs(attrs: dict[str, Any] | None, keep: int = 6) -> str:
    if not attrs:
        return "-"
    items = list(attrs.items())[:keep]
    return "; ".join(f"{k}={v}" for k, v in items)


# ---------------------------------------------------------------------------
# 1. Dataset / ward scoped features
# ---------------------------------------------------------------------------
async def build_dataset_or_ward_context(
    db: AsyncSession,
    *,
    dataset_id: uuid.UUID | None,
    ward: str | None,
    max_features: int,
) -> GroundedContext:
    if dataset_id is None and ward is None:
        return GroundedContext(text="", count=0, debug={"reason": "no scope supplied"})

    params: dict[str, Any] = {"limit": max_features}
    conditions: list[str] = []
    if dataset_id is not None:
        conditions.append("f.dataset_id = :dataset_id")
        params["dataset_id"] = dataset_id
    if ward is not None:
        conditions.append("d.ward = :ward")
        params["ward"] = ward

    where_clause = " AND ".join(conditions)
    sql = text(
        f"""
        SELECT
            f.id::text            AS id,
            f.label               AS label,
            f.category            AS category,
            f.severity            AS severity,
            f.attributes          AS attributes,
            d.name                AS dataset_name,
            d.ward                AS ward,
            ST_AsText(f.geom)     AS geom_wkt
        FROM features f
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        ORDER BY f.severity DESC
        LIMIT :limit
        """
    )
    rows = (await db.execute(sql, params)).mappings().all()

    if not rows:
        return GroundedContext(text="", count=0, debug={"scope": params})

    # Aggregate stats
    stats_sql = text(
        f"""
        SELECT
            COUNT(*)                       AS total,
            AVG(f.severity)                AS avg_severity,
            COUNT(DISTINCT f.category)     AS categories,
            COUNT(DISTINCT d.id)           AS datasets
        FROM features f
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        """
    )
    stats = (await db.execute(stats_sql, {k: v for k, v in params.items() if k != "limit"})).mappings().one()

    review_sql = text(
        f"""
        SELECT r.status, COUNT(*) AS c
        FROM review_items r
        JOIN features f ON f.id = r.feature_id
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        GROUP BY r.status
        """
    )
    review_rows = (await db.execute(review_sql, {k: v for k, v in params.items() if k != "limit"})).mappings().all()
    review_summary = ", ".join(f"{r['status']}={r['c']}" for r in review_rows) or "no review items"

    lines: list[str] = []
    scope_label = []
    if dataset_id:
        scope_label.append(f"dataset_id={dataset_id}")
    if ward:
        scope_label.append(f"ward={ward}")
    lines.append(f"SCOPE: {' | '.join(scope_label)}")
    lines.append(
        f"STATS: total_features={stats['total']}, "
        f"avg_severity={float(stats['avg_severity'] or 0):.3f}, "
        f"distinct_categories={stats['categories']}, "
        f"distinct_datasets={stats['datasets']}"
    )
    lines.append(f"REVIEW_ITEMS: {review_summary}")
    lines.append("")
    lines.append(f"TOP FEATURES (up to {max_features}, severity desc):")

    for idx, r in enumerate(rows, start=1):
        lines.append(
            f"  {idx}. id={r['id']} · label={r['label'] or '-'} · "
            f"category={r['category'] or '-'} · severity={float(r['severity']):.2f} · "
            f"dataset='{r['dataset_name']}' · ward={r['ward'] or '-'} · "
            f"geom={r['geom_wkt'][:80]}{'…' if r['geom_wkt'] and len(r['geom_wkt']) > 80 else ''} · "
            f"attrs=[{_fmt_attrs(r['attributes'])}]"
        )

    return GroundedContext(
        text="\n".join(lines),
        count=len(rows),
        debug={
            "scope": {k: str(v) for k, v in params.items() if k != "limit"},
            "review_summary": review_summary,
        },
    )


# ---------------------------------------------------------------------------
# 2. Feature-id list scoped (for /query with explicit selection)
# ---------------------------------------------------------------------------
async def build_feature_ids_context(
    db: AsyncSession, *, feature_ids: list[uuid.UUID]
) -> GroundedContext:
    if not feature_ids:
        return GroundedContext(text="", count=0, debug={})

    sql = text(
        """
        SELECT
            f.id::text          AS id,
            f.label             AS label,
            f.category          AS category,
            f.severity          AS severity,
            f.attributes        AS attributes,
            d.name              AS dataset_name,
            d.ward              AS ward,
            ST_AsText(f.geom)   AS geom_wkt
        FROM features f
        JOIN datasets d ON d.id = f.dataset_id
        WHERE f.id = ANY(:ids)
        """
    )
    rows = (await db.execute(sql, {"ids": [fid for fid in feature_ids]})).mappings().all()
    if not rows:
        return GroundedContext(text="", count=0, debug={"requested_ids": [str(f) for f in feature_ids]})

    lines = [f"USER-SELECTED FEATURES ({len(rows)}):"]
    for idx, r in enumerate(rows, start=1):
        lines.append(
            f"  {idx}. id={r['id']} · label={r['label'] or '-'} · category={r['category'] or '-'} · "
            f"severity={float(r['severity']):.2f} · dataset='{r['dataset_name']}' · ward={r['ward'] or '-'} · "
            f"geom={r['geom_wkt'][:80]} · attrs=[{_fmt_attrs(r['attributes'])}]"
        )
    return GroundedContext(text="\n".join(lines), count=len(rows), debug={})


# ---------------------------------------------------------------------------
# 3. Prioritization context — open reviews across DB (optional ward filter)
# ---------------------------------------------------------------------------
async def build_prioritize_context(
    db: AsyncSession, *, ward: str | None, limit: int
) -> GroundedContext:
    params: dict[str, Any] = {"limit": limit}
    conditions = ["r.status IN ('open','reviewing','in_progress','blocked')"]
    if ward is not None:
        conditions.append("d.ward = :ward")
        params["ward"] = ward
    where_clause = " AND ".join(conditions)

    sql = text(
        f"""
        SELECT
            r.id::text                             AS review_id,
            r.title                                AS title,
            r.priority                             AS priority,
            r.status                               AS status,
            r.first_response_at                    AS first_response_at,
            r.created_at                           AS created_at,
            f.id::text                             AS feature_id,
            f.category                             AS category,
            f.severity                             AS severity,
            d.ward                                 AS ward,
            d.name                                 AS dataset_name,
            EXTRACT(EPOCH FROM (NOW() - r.created_at))/3600 AS age_hours
        FROM review_items r
        JOIN features f ON f.id = r.feature_id
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        ORDER BY r.priority ASC, f.severity DESC, r.created_at ASC
        LIMIT :limit
        """
    )
    rows = (await db.execute(sql, params)).mappings().all()
    if not rows:
        return GroundedContext(text="", count=0, debug={"ward": ward})

    lines = [f"OPEN BACKLOG ({len(rows)} rows, ward={ward or 'ALL'}):"]
    for idx, r in enumerate(rows, start=1):
        lines.append(
            f"  {idx}. review_id={r['review_id']} · feature_id={r['feature_id']} · "
            f"P{r['priority']} · status={r['status']} · severity={float(r['severity']):.2f} · "
            f"category={r['category'] or '-'} · ward={r['ward'] or '-'} · "
            f"dataset='{r['dataset_name']}' · age_h={float(r['age_hours'] or 0):.1f} · "
            f"title='{r['title'][:100]}'"
        )
    return GroundedContext(text="\n".join(lines), count=len(rows), debug={"ward": ward})


# ---------------------------------------------------------------------------
# 4. Recommend — deep dive on one feature (feature + reviews + comments)
# ---------------------------------------------------------------------------
async def build_recommend_context(
    db: AsyncSession, *, feature_id: uuid.UUID
) -> GroundedContext:
    feature = (
        await db.execute(
            text(
                """
                SELECT f.id::text AS id, f.label, f.category, f.severity,
                       f.attributes, d.ward, d.name AS dataset_name,
                       ST_AsText(f.geom) AS geom_wkt
                FROM features f JOIN datasets d ON d.id = f.dataset_id
                WHERE f.id = :fid
                """
            ),
            {"fid": feature_id},
        )
    ).mappings().one_or_none()

    if feature is None:
        return GroundedContext(text="", count=0, debug={"reason": "feature_not_found"})

    reviews = (
        await db.execute(
            text(
                """
                SELECT id::text AS id, title, description, priority, status,
                       first_response_at, resolved_at, created_at
                FROM review_items
                WHERE feature_id = :fid
                ORDER BY created_at DESC
                LIMIT 25
                """
            ),
            {"fid": feature_id},
        )
    ).mappings().all()

    comments = (
        await db.execute(
            text(
                """
                SELECT c.id::text AS id, c.body, c.created_at, u.name AS author
                FROM comments c LEFT JOIN users u ON u.id = c.author_id
                WHERE c.feature_id = :fid
                ORDER BY c.created_at DESC
                LIMIT 25
                """
            ),
            {"fid": feature_id},
        )
    ).mappings().all()

    lines: list[str] = []
    lines.append(
        f"FEATURE: id={feature['id']} · label={feature['label'] or '-'} · "
        f"category={feature['category'] or '-'} · severity={float(feature['severity']):.2f} · "
        f"ward={feature['ward'] or '-'} · dataset='{feature['dataset_name']}'"
    )
    lines.append(
        f"GEOMETRY: {feature['geom_wkt'][:200]}"
    )
    lines.append(f"ATTRIBUTES: {_fmt_attrs(feature['attributes'], keep=20)}")

    if reviews:
        lines.append("")
        lines.append(f"REVIEW ITEMS ({len(reviews)}):")
        for idx, r in enumerate(reviews, start=1):
            lines.append(
                f"  {idx}. id={r['id']} · P{r['priority']} · status={r['status']} · "
                f"title='{r['title'][:100]}'"
                + (f" · desc='{r['description'][:120]}'" if r['description'] else "")
            )

    if comments:
        lines.append("")
        lines.append(f"COMMENTS ({len(comments)}):")
        for idx, c in enumerate(comments, start=1):
            lines.append(
                f"  {idx}. by {c['author'] or 'unknown'} @ {c['created_at']}: {c['body'][:240]}"
            )

    return GroundedContext(
        text="\n".join(lines),
        count=1 + len(reviews) + len(comments),
        debug={"feature_id": str(feature_id), "reviews": len(reviews), "comments": len(comments)},
    )

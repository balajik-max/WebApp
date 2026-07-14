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

from app.services.analytics.quality import build_quality_report


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
    category: str | None = None,
    max_features: int,
) -> GroundedContext:
    if dataset_id is None and ward is None:
        return GroundedContext(text="", count=0, debug={"reason": "no scope supplied"})

    params: dict[str, Any] = {"limit": max_features}
    # raster_pixel is the RasterReader's internal sample grid, not a real
    # surveyed asset — excluded everywhere else, so summarize/query must
    # exclude it too rather than let it dominate the LLM's context.
    conditions: list[str] = ["f.category IS DISTINCT FROM 'raster_pixel'"]
    if dataset_id is not None:
        conditions.append("f.dataset_id = :dataset_id")
        params["dataset_id"] = dataset_id
    if ward is not None:
        conditions.append("d.ward = :ward")
        params["ward"] = ward
    if category is not None:
        # Mirrors whatever category the user has active in the topbar
        # filter, so "Ask" answers the same scope the map is showing —
        # without this, a category filter on-screen was silently ignored
        # by the AI, which always summarized the whole ward/dataset.
        conditions.append("f.category = :category")
        params["category"] = category

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

    # Full category tally across EVERY matching feature (not just the
    # severity-sorted top-N sample below) — a report claiming e.g. "633
    # Buildings" must be counting the real total, not extrapolating from
    # a capped sample.
    category_sql = text(
        f"""
        SELECT COALESCE(NULLIF(f.category, ''), 'uncategorized') AS category, COUNT(*) AS c
        FROM features f
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        GROUP BY category
        ORDER BY c DESC
        """
    )
    category_rows = (
        (await db.execute(category_sql, {k: v for k, v in params.items() if k != "limit"})).mappings().all()
    )

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
    lines.append("CATEGORY BREAKDOWN (full count across ALL matching features, not a sample):")
    for r in category_rows:
        lines.append(f"  {r['category']}: {r['c']}")
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
# 3. Recommend — deep dive on one feature (feature + reviews + comments)
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


# ---------------------------------------------------------------------------
# 4. Structured, non-text facts for the ward/dataset report
#
# The /report endpoint used to hand the LLM a text blob and ask it to
# restate counts and categories itself — even a well-grounded prompt
# couldn't stop a small local model from occasionally inventing a
# category that doesn't exist or confusing a sample size with the real
# total. Every number/category the report shows now comes straight from
# these SQL-computed facts, rendered by Python — the LLM is only ever
# asked to write narrative/prescriptive prose *around* facts it is
# handed, never to recall or compute a fact itself.
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class CategoryFact:
    category: str
    count: int
    avg_severity: float


@dataclass(slots=True)
class TopFeatureFact:
    id: str
    label: str
    category: str
    severity: float
    dataset_name: str


@dataclass(slots=True)
class QualityFindingFact:
    title: str
    severity: str
    affected_count: int
    affected_percentage: float
    priority_score: int
    rule: str


@dataclass(slots=True)
class ReportFacts:
    scope_label: str
    total_features: int
    distinct_categories: int
    distinct_datasets: int
    avg_severity: float
    review_summary: str
    categories: list[CategoryFact]
    top_features: list[TopFeatureFact]
    severity_buckets: dict[str, int]  # low/medium/high
    quality_score: float | None
    quality_findings: list[QualityFindingFact]


async def build_report_facts(
    db: AsyncSession,
    *,
    dataset_id: uuid.UUID | None,
    ward: str | None,
    dataset_ids: list[uuid.UUID] | None = None,
    categories: list[str] | None = None,
    severity_buckets: list[str] | None = None,
    allow_all: bool = False,
    top_feature_limit: int = 8,
) -> ReportFacts | None:
    combined_dataset_ids = list(dict.fromkeys(dataset_ids or []))
    if dataset_id is not None and dataset_id not in combined_dataset_ids:
        combined_dataset_ids.append(dataset_id)

    cleaned_categories = sorted({value.strip() for value in categories or [] if value.strip()})
    cleaned_severity_buckets = sorted(
        {value.strip().lower() for value in severity_buckets or [] if value.strip()}
    )
    if any(value not in {"low", "medium", "high"} for value in cleaned_severity_buckets):
        return None
    if not allow_all and not combined_dataset_ids and ward is None:
        return None

    params: dict[str, Any] = {}
    conditions: list[str] = ["f.category IS DISTINCT FROM 'raster_pixel'"]
    if combined_dataset_ids:
        conditions.append("f.dataset_id = ANY(:dataset_ids)")
        params["dataset_ids"] = combined_dataset_ids
    if ward is not None:
        conditions.append("d.ward = :ward")
        params["ward"] = ward
    if cleaned_categories:
        conditions.append(
            "COALESCE(NULLIF(BTRIM(f.category), ''), 'uncategorized') = ANY(:categories)"
        )
        params["categories"] = cleaned_categories
    if cleaned_severity_buckets:
        severity_conditions: list[str] = []
        if "low" in cleaned_severity_buckets:
            severity_conditions.append("f.severity < 0.34")
        if "medium" in cleaned_severity_buckets:
            severity_conditions.append("(f.severity >= 0.34 AND f.severity < 0.67)")
        if "high" in cleaned_severity_buckets:
            severity_conditions.append("f.severity >= 0.67")
        conditions.append("(" + " OR ".join(severity_conditions) + ")")
    where_clause = " AND ".join(conditions)

    stats_sql = text(
        f"""
        SELECT
            COUNT(*) AS total,
            AVG(f.severity) AS avg_severity,
            COUNT(DISTINCT COALESCE(NULLIF(BTRIM(f.category), ''), 'uncategorized')) AS categories,
            COUNT(DISTINCT d.id) AS datasets
        FROM features f
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        """
    )
    stats = (await db.execute(stats_sql, params)).mappings().one()
    total = int(stats["total"] or 0)
    if total == 0:
        return None

    category_sql = text(
        f"""
        SELECT COALESCE(NULLIF(BTRIM(f.category), ''), 'uncategorized') AS category,
               COUNT(*) AS c, AVG(f.severity) AS avg_severity
        FROM features f
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        GROUP BY category
        ORDER BY c DESC, category ASC
        """
    )
    category_rows = (await db.execute(category_sql, params)).mappings().all()

    top_sql = text(
        f"""
        SELECT f.id::text AS id,
               COALESCE(NULLIF(BTRIM(f.label), ''), f.attributes ->> 'FID', f.id::text) AS label,
               COALESCE(NULLIF(BTRIM(f.category), ''), 'uncategorized') AS category,
               f.severity AS severity, d.name AS dataset_name
        FROM features f
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        ORDER BY f.severity DESC, f.created_at, f.id
        LIMIT :top_limit
        """
    )
    top_rows = (
        await db.execute(top_sql, {**params, "top_limit": top_feature_limit})
    ).mappings().all()

    severity_sql = text(
        f"""
        SELECT
            CASE WHEN f.severity < 0.34 THEN 'low'
                 WHEN f.severity < 0.67 THEN 'medium'
                 ELSE 'high' END AS bucket,
            COUNT(*) AS c
        FROM features f
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        GROUP BY bucket
        """
    )
    severity_rows = (await db.execute(severity_sql, params)).mappings().all()
    severity_buckets = {bucket: 0 for bucket in ("low", "medium", "high")}
    for row in severity_rows:
        severity_buckets[row["bucket"]] = int(row["c"])

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
    review_rows = (await db.execute(review_sql, params)).mappings().all()
    review_summary = ", ".join(f"{row['status']}={row['c']}" for row in review_rows) or "no review items"

    quality_report = await build_quality_report(
        db,
        dataset_ids=combined_dataset_ids,
        categories=cleaned_categories,
        wards=[ward] if ward else [],
        severity_buckets=cleaned_severity_buckets,  # type: ignore[arg-type]
    )

    if ward:
        scope_label = f"ward {ward}"
    elif combined_dataset_ids:
        scope_label = (
            f"dataset {combined_dataset_ids[0]}"
            if len(combined_dataset_ids) == 1
            else f"{len(combined_dataset_ids)} selected datasets"
        )
    else:
        scope_label = "all datasets"
    if cleaned_categories:
        category_label = ", ".join(cleaned_categories[:8])
        if len(cleaned_categories) > 8:
            category_label += f", and {len(cleaned_categories) - 8} more"
        scope_label += f" | categories: {category_label}"
    if cleaned_severity_buckets:
        scope_label += f" | severity: {', '.join(cleaned_severity_buckets)}"

    return ReportFacts(
        scope_label=scope_label,
        total_features=total,
        distinct_categories=int(stats["categories"] or 0),
        distinct_datasets=int(stats["datasets"] or 0),
        avg_severity=float(stats["avg_severity"] or 0.0),
        review_summary=review_summary,
        categories=[
            CategoryFact(
                category=row["category"],
                count=int(row["c"]),
                avg_severity=float(row["avg_severity"] or 0.0),
            )
            for row in category_rows
        ],
        top_features=[
            TopFeatureFact(
                id=row["id"],
                label=row["label"] or "-",
                category=row["category"],
                severity=float(row["severity"]),
                dataset_name=row["dataset_name"],
            )
            for row in top_rows
        ],
        severity_buckets=severity_buckets,
        quality_score=quality_report.overall_score,
        quality_findings=[
            QualityFindingFact(
                title=finding.title,
                severity=finding.severity,
                affected_count=finding.affected_count,
                affected_percentage=finding.affected_percentage,
                priority_score=finding.priority_score,
                rule=finding.rule,
            )
            for finding in quality_report.findings[:8]
        ],
    )


# ---------------------------------------------------------------------------
# 5. Spacing / redundancy analysis for a single category (e.g. "are these
#    power poles too close together?").
#
# Distances are computed once, in SQL, via a real geography self-join —
# the LLM is never shown raw coordinates and asked to judge distance
# itself (a model can't reliably do arithmetic on lat/lon), only the
# already-computed metre distances and cluster groupings below.
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class ProximityPair:
    id_a: str
    label_a: str
    id_b: str
    label_b: str
    distance_m: float


@dataclass(slots=True)
class NeededLocation:
    id: str
    lon: float
    lat: float
    reason: str


@dataclass(slots=True)
class ProximityFacts:
    scope_label: str
    category: str
    threshold_m: float
    total_in_scope: int
    pairs: list[ProximityPair]
    cluster_sizes: list[int]  # e.g. [3, 2] = one cluster of 3 mutually-close features, one of 2
    clustered_feature_count: int
    # AI redundancy classification - populated by _classify_redundancy()
    redundant_feature_ids: list[str]
    needed_feature_ids: list[str]
    needed_locations: list[NeededLocation]
    local_graph_threshold_m: float
    max_removal_gap_m: float


def _cluster_pairs(pairs: list[ProximityPair]) -> list[list[str]]:
    """Union-find over feature ids connected by a within-threshold pair,
    so three power poles each within range of at least one other in the
    group are reported as ONE cluster of 3, not three separate pairs."""
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for p in pairs:
        union(p.id_a, p.id_b)

    groups: dict[str, list[str]] = {}
    for node in parent:
        groups.setdefault(find(node), []).append(node)
    return list(groups.values())


# ---------------------------------------------------------------------------
# Redundancy classification — Minimum Spanning Tree approach
#
# Strategy:
#   1. Build a complete graph of all poles using their real measured distances.
#   2. Compute the Minimum Spanning Tree (Kruskal's algorithm) — this is the
#      smallest set of edges that keeps every pole reachable from every other.
#   3. Poles that appear on the MST are STRUCTURALLY NEEDED (green) — removing
#      any one of them would disconnect part of the network.
#   4. Poles that do NOT appear on the MST are REDUNDANT (red) — the network
#      stays fully connected without them.
#
# Exception — isolated poles (not connected to any other pole within the
# threshold) are always NEEDED because they have no redundant duplicate.
#
# This correctly handles dense clusters: 3 poles at 9 m intervals in a line →
# MST uses 2 edges (pole A–B, pole B–C) → pole B is on the MST (needed),
# poles A and C are endpoints (needed). But if there's a 4th pole D at 8 m
# from B going in the same direction, the MST edge B–D is shorter than A–B
# so A becomes the redundant one. All intra-cluster extras get flagged red.
# ---------------------------------------------------------------------------

import math as _math


def _bearing(ax: float, ay: float, bx: float, by: float) -> float:
    """Compass bearing in degrees [0, 360) from point A to point B."""
    dx = bx - ax
    dy = by - ay
    angle = _math.degrees(_math.atan2(dx, dy)) % 360
    return angle


def _angle_diff(a: float, b: float) -> float:
    """Smallest angular difference between two bearings [0, 180]."""
    d = abs(a - b) % 360
    return d if d <= 180 else 360 - d


def _distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Approximate lon/lat distance in metres for local de-duplication."""
    lon1, lat1 = map(_math.radians, a)
    lon2, lat2 = map(_math.radians, b)
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    h = _math.sin(dlat / 2) ** 2 + _math.cos(lat1) * _math.cos(lat2) * _math.sin(dlon / 2) ** 2
    return 6371000.0 * 2 * _math.asin(min(1.0, _math.sqrt(h)))


def _kruskal_mst(
    nodes: list[str],
    edges: list[tuple[float, str, str]],  # (distance, id_a, id_b) sorted asc
) -> set[str]:
    """Return the set of node IDs that appear in the MST (Kruskal's algorithm).
    Nodes not connected to any edge (isolated) are included as needed by default.
    """
    parent: dict[str, str] = {n: n for n in nodes}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> bool:
        ra, rb = find(a), find(b)
        if ra == rb:
            return False
        parent[ra] = rb
        return True

    mst_nodes: set[str] = set()
    for _dist, a, b in edges:
        if union(a, b):
            mst_nodes.add(a)
            mst_nodes.add(b)

    return mst_nodes


def _classify_redundancy(
    poles: dict[str, tuple[float, float]],
    pairs: list[ProximityPair],          # ALL pairs within the user threshold (e.g. 200m)
) -> tuple[list[str], list[str], float, float]:
    """Return (redundant_ids, needed_existing_ids, local_threshold_m, max_gap_m).

    The map overlay is intentionally conservative:
    - RED is only for very tight duplicate candidates among existing poles.
    - GREEN is not applied to existing poles. A green marker should mean a
      proposed missing/service-gap location, not "keep this existing pole".

    Without a field-verified electrical network topology, coloring ordinary
    line poles red is misleading. We therefore only flag duplicate candidates
    when poles are closer than DUPLICATE_M and part of a local duplicate group.
    """
    duplicate_m = 20.0
    report_local_threshold_m = 40.0

    if not pairs:
        return [], [], report_local_threshold_m, report_local_threshold_m * 2

    duplicate_pairs = [p for p in pairs if p.distance_m <= duplicate_m]
    if not duplicate_pairs:
        return [], [], report_local_threshold_m, report_local_threshold_m * 2

    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for p in duplicate_pairs:
        union(p.id_a, p.id_b)

    groups: dict[str, list[str]] = {}
    for node in parent:
        groups.setdefault(find(node), []).append(node)

    nearest: dict[str, float] = {}
    for p in duplicate_pairs:
        nearest[p.id_a] = min(nearest.get(p.id_a, p.distance_m), p.distance_m)
        nearest[p.id_b] = min(nearest.get(p.id_b, p.distance_m), p.distance_m)

    redundant: list[str] = []
    for group in groups.values():
        if len(group) < 2:
            continue
        # Keep one representative existing pole in each duplicate group.
        # Prefer the pole whose nearest duplicate is farthest away; it is the
        # least obviously duplicated. Flag the rest as removal-review red.
        keep = max(group, key=lambda pid: (nearest.get(pid, 0.0), pid))
        redundant.extend(pid for pid in group if pid != keep)

    return sorted(set(redundant)), [], report_local_threshold_m, report_local_threshold_m * 2
async def build_proximity_facts(
    db: AsyncSession,
    *,
    dataset_id: uuid.UUID | None,
    ward: str | None,
    category: str,
    threshold_m: float = 200.0,
    max_pairs: int = 300,
) -> ProximityFacts | None:
    if dataset_id is None and ward is None:
        return None

    params: dict[str, Any] = {"category": category}
    conditions: list[str] = [
        "f.category IS DISTINCT FROM 'raster_pixel'",
        "f.category = :category",
    ]
    if dataset_id is not None:
        conditions.append("f.dataset_id = :dataset_id")
        params["dataset_id"] = dataset_id
    if ward is not None:
        conditions.append("d.ward = :ward")
        params["ward"] = ward
    where_clause = " AND ".join(conditions)

    total_sql = text(
        f"""
        SELECT COUNT(*) AS total
        FROM features f
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        """
    )
    total = int((await db.execute(total_sql, params)).scalar_one() or 0)
    if total == 0:
        return None

    pairs_sql = text(
        f"""
        WITH scoped AS (
            SELECT f.id::text AS id, f.label AS label, f.geom AS geom
            FROM features f
            JOIN datasets d ON d.id = f.dataset_id
            WHERE {where_clause}
        )
        SELECT
            a.id AS id_a, a.label AS label_a,
            b.id AS id_b, b.label AS label_b,
            ST_Distance(a.geom::geography, b.geom::geography) AS distance_m
        FROM scoped a
        JOIN scoped b ON a.id < b.id
        WHERE ST_DWithin(a.geom::geography, b.geom::geography, :threshold_m)
        ORDER BY distance_m ASC
        LIMIT :max_pairs
        """
    )
    rows = (
        await db.execute(pairs_sql, {**params, "threshold_m": threshold_m, "max_pairs": max_pairs})
    ).mappings().all()

    # Many GIS survey layers (e.g. this shapefile's power poles) carry no
    # name/label attribute at all — every field is genuinely null. Falling
    # back to "<category> #<short id>" keeps each row distinguishable
    # instead of two unlabeled features both rendering as a meaningless "-".
    pairs = [
        ProximityPair(
            id_a=r["id_a"],
            label_a=r["label_a"] or f"{category} #{r['id_a'][:8]}",
            id_b=r["id_b"],
            label_b=r["label_b"] or f"{category} #{r['id_b'][:8]}",
            distance_m=float(r["distance_m"]),
        )
        for r in rows
    ]
    clusters = _cluster_pairs(pairs)
    clustered_ids = {fid for group in clusters for fid in group}

    # ---- fetch coordinates for all poles in scope -------------------------
    coord_sql = text(
        f"""
        SELECT f.id::text AS id,
               ST_X(f.geom::geometry) AS lon,
               ST_Y(f.geom::geometry) AS lat
        FROM features f
        JOIN datasets d ON d.id = f.dataset_id
        WHERE {where_clause}
        """
    )
    coord_rows = (await db.execute(coord_sql, params)).mappings().all()
    pole_coords: dict[str, tuple[float, float]] = {
        r["id"]: (float(r["lon"]), float(r["lat"])) for r in coord_rows
    }

    # Pass all within-threshold pairs to the classifier.
    redundant_ids, needed_ids, local_graph_threshold_m, max_removal_gap_m = _classify_redundancy(
        pole_coords,
        pairs,
    )

    road_where = (
        where_clause
        .replace("f.category IS DISTINCT FROM 'raster_pixel' AND ", "")
        .replace("f.category = :category", "f.category IN ('Concrete Road', 'Concrete Edge', 'Sidewalk', 'Power Line')")
    )

    needed_sql = text(
        f"""
        WITH road_lines AS (
            SELECT (ST_Dump(f.geom::geometry)).geom AS geom
            FROM features f
            JOIN datasets d ON d.id = f.dataset_id
            WHERE {road_where}
        ), sampled AS (
            SELECT
                ST_LineInterpolatePoint(
                    geom,
                    LEAST(0.98, GREATEST(0.02, gs.i / GREATEST(1.0, CEIL(ST_Length(geom::geography) / 50.0))))
                ) AS geom
            FROM road_lines
            CROSS JOIN LATERAL generate_series(1, GREATEST(1, CEIL(ST_Length(geom::geography) / 50.0))::int - 1) AS gs(i)
            WHERE ST_Length(geom::geography) >= 55
        ), poles AS (
            SELECT f.geom
            FROM features f
            JOIN datasets d ON d.id = f.dataset_id
            WHERE {where_clause}
        ), gaps AS (
            SELECT s.geom, MIN(ST_Distance(s.geom::geography, p.geom::geography)) AS nearest_pole_m
            FROM sampled s
            LEFT JOIN poles p ON ST_DWithin(s.geom::geography, p.geom::geography, 120)
            GROUP BY s.geom
        )
        SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, nearest_pole_m
        FROM gaps
        WHERE nearest_pole_m IS NULL OR nearest_pole_m > 50
        ORDER BY COALESCE(nearest_pole_m, 9999) DESC
        LIMIT 120
        """
    )
    gap_rows = (await db.execute(needed_sql, params)).mappings().all()
    needed_locations: list[NeededLocation] = []
    selected_coords: list[tuple[float, float]] = []
    for r in gap_rows:
        coord = (float(r["lon"]), float(r["lat"]))
        if any(_distance_m(coord, existing) < 45.0 for existing in selected_coords):
            continue
        selected_coords.append(coord)
        nearest = float(r["nearest_pole_m"] or 9999)
        needed_locations.append(
            NeededLocation(
                id=f"needed-{len(needed_locations) + 1}",
                lon=coord[0],
                lat=coord[1],
                reason=f"Road/service gap: nearest surveyed {category} is {nearest:.0f} m away",
            )
        )
        if len(needed_locations) >= 12:
            break
    import logging as _logging
    _log = _logging.getLogger("davangere.ai_context")
    _log.warning(
        "SPACING DEBUG: total=%d  redundant=%d  critical=%d  MAS=%.1f",
        total, len(redundant_ids), len(needed_locations), local_graph_threshold_m,
    )

    scope_label = f"ward {ward}" if ward else f"dataset {dataset_id}"

    return ProximityFacts(
        scope_label=scope_label,
        category=category,
        threshold_m=threshold_m,
        total_in_scope=total,
        pairs=pairs,
        cluster_sizes=sorted((len(g) for g in clusters), reverse=True),
        clustered_feature_count=len(clustered_ids),
        redundant_feature_ids=redundant_ids,
        needed_feature_ids=needed_ids,
        needed_locations=needed_locations,
        local_graph_threshold_m=local_graph_threshold_m,
        max_removal_gap_m=max_removal_gap_m,
    )

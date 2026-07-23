"""Dynamic category -> canonical class resolution.

Resolution order (cheapest/most-deterministic first):
  1. Cache hit in category_class_map (covers every raw string ever resolved,
     system-wide).
  2. Exact/normalized synonym match against CLASS_SYNONYMS (instant, no
     model call, fully deterministic and auditable in code review).
  3. Embedding-based semantic match against CANONICAL_CLASSES descriptions,
     via the local nomic-embed-text model — only reached for genuinely
     novel category strings, and the result is cached so this never runs
     twice for the same string.
  4. Below the confidence threshold: "Unclassified", left for a human to
     map manually. Never silently guessed — this is a government system
     and every mapping must be auditable.

This module ONLY resolves category *names* to a semantic class. It has
nothing to do with spatial/geometric reasoning, which stays entirely in
app.services.spatial_audit as deterministic PostGIS/Python math.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category_class_map import CategoryClassMap, ClassMatchMethod
from app.services.ai import embed_texts
from app.services.class_taxonomy import CANONICAL_CLASSES, CLASS_SYNONYMS, normalize_category

log = logging.getLogger("davangere.classification")

UNCLASSIFIED = "Unclassified"
EMBEDDING_CONFIDENCE_THRESHOLD = 0.60

# Lazily computed, process-lifetime cache of canonical-class description
# embeddings — nine short strings, computed once per process, never per
# request. Populated on first embedding-fallback call.
_class_embeddings: dict[str, list[float]] | None = None

# Reverse lookup: normalized synonym string -> canonical class.
_synonym_lookup: dict[str, str] = {
    normalize_category(syn): cls
    for cls, synonyms in CLASS_SYNONYMS.items()
    for syn in synonyms
}


@dataclass(slots=True)
class ClassResolution:
    canonical_class: str
    match_method: ClassMatchMethod
    confidence: float


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


async def _class_description_embeddings() -> dict[str, list[float]]:
    global _class_embeddings
    if _class_embeddings is None:
        classes = list(CANONICAL_CLASSES.keys())
        descriptions = [CANONICAL_CLASSES[c] for c in classes]
        vectors = await embed_texts(descriptions)
        _class_embeddings = dict(zip(classes, vectors))
    return _class_embeddings


async def _embed_fallback(raw_category: str) -> tuple[str, float]:
    """Returns (canonical_class_or_UNCLASSIFIED, confidence)."""
    try:
        class_embeddings = await _class_description_embeddings()
        [raw_vec] = await embed_texts([raw_category])
    except Exception:  # noqa: BLE001 — embedding model unavailable shouldn't crash ingestion
        log.exception("Embedding fallback failed for raw_category=%r; leaving Unclassified", raw_category)
        return UNCLASSIFIED, 0.0

    best_class = UNCLASSIFIED
    best_score = 0.0
    for cls, vec in class_embeddings.items():
        score = _cosine_similarity(raw_vec, vec)
        if score > best_score:
            best_score = score
            best_class = cls

    if best_score < EMBEDDING_CONFIDENCE_THRESHOLD:
        return UNCLASSIFIED, best_score
    return best_class, best_score


async def resolve_canonical_class(raw_category: str, session: AsyncSession) -> ClassResolution:
    """Resolve one raw category string to a canonical class, caching the result."""
    existing = (
        await session.execute(
            select(CategoryClassMap).where(CategoryClassMap.raw_category == raw_category)
        )
    ).scalar_one_or_none()
    normalized = normalize_category(raw_category)
    synonym_hit = _synonym_lookup.get(normalized)
    if existing is not None:
        # Taxonomy lists grow as new surveyed feature classes are formally
        # approved. Upgrade only a previously unresolved cache entry when an
        # exact synonym now exists; never overwrite a human/manual mapping.
        if existing.canonical_class == UNCLASSIFIED and synonym_hit is not None:
            existing.canonical_class = synonym_hit
            existing.match_method = ClassMatchMethod.EXACT
            existing.confidence = 1.0
            await session.commit()
            return ClassResolution(synonym_hit, ClassMatchMethod.EXACT, 1.0)
        return ClassResolution(existing.canonical_class, existing.match_method, existing.confidence)

    if synonym_hit is not None:
        resolution = ClassResolution(synonym_hit, ClassMatchMethod.EXACT, 1.0)
    else:
        canonical_class, score = await _embed_fallback(raw_category)
        resolution = ClassResolution(canonical_class, ClassMatchMethod.EMBEDDING, score)

    await _cache_resolution(raw_category, resolution, session)
    return resolution


async def resolve_canonical_classes_bulk(
    raw_categories: set[str], session: AsyncSession
) -> dict[str, ClassResolution]:
    """Resolve many distinct raw categories from one ingestion batch.

    Each distinct string only ever triggers at most one embedding call
    (via resolve_canonical_class's cache-then-resolve path) — this is what
    keeps classification cheap regardless of how many feature ROWS share
    that category.
    """
    results: dict[str, ClassResolution] = {}
    for raw in raw_categories:
        if not raw or not raw.strip():
            continue
        results[raw] = await resolve_canonical_class(raw, session)
    return results


async def _cache_resolution(raw_category: str, resolution: ClassResolution, session: AsyncSession) -> None:
    # ON CONFLICT DO NOTHING: two concurrent ingestions resolving the same
    # brand-new category is a benign race — whichever inserts first wins,
    # the other just re-reads on its next call.
    stmt = (
        pg_insert(CategoryClassMap)
        .values(
            raw_category=raw_category,
            canonical_class=resolution.canonical_class,
            match_method=resolution.match_method,
            confidence=resolution.confidence,
        )
        .on_conflict_do_nothing(index_elements=[CategoryClassMap.raw_category])
    )
    await session.execute(stmt)
    await session.commit()

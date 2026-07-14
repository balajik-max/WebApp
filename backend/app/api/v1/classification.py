"""Manual override endpoints for category -> canonical-class resolution.

Every raw category the classifier couldn't confidently resolve is left as
"Unclassified" (see app.services.classification) rather than guessed — these
endpoints are the human-in-the-loop escape hatch: list what's unresolved,
let an admin/architect assign the correct canonical class.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db
from app.models import User
from app.models.category_class_map import CategoryClassMap, ClassMatchMethod
from app.services.class_taxonomy import CANONICAL_CLASSES
from app.services.classification import UNCLASSIFIED

router = APIRouter()


class CategoryClassMapOut(BaseModel):
    raw_category: str
    canonical_class: str
    match_method: ClassMatchMethod
    confidence: float

    model_config = {"from_attributes": True}


class ManualClassAssignment(BaseModel):
    canonical_class: str = Field(min_length=1, max_length=64)


@router.get("/classes", response_model=list[str])
async def list_canonical_classes(_: User = Depends(require_any)) -> list[str]:
    return list(CANONICAL_CLASSES.keys())


@router.get("/unclassified", response_model=list[CategoryClassMapOut])
async def list_unclassified(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_any),
) -> list[CategoryClassMapOut]:
    rows = (
        await db.execute(
            select(CategoryClassMap)
            .where(CategoryClassMap.canonical_class == UNCLASSIFIED)
            .order_by(CategoryClassMap.raw_category)
        )
    ).scalars().all()
    return [CategoryClassMapOut.model_validate(r) for r in rows]


@router.get("", response_model=list[CategoryClassMapOut])
async def list_all_mappings(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_any),
) -> list[CategoryClassMapOut]:
    rows = (
        await db.execute(select(CategoryClassMap).order_by(CategoryClassMap.raw_category))
    ).scalars().all()
    return [CategoryClassMapOut.model_validate(r) for r in rows]


@router.patch("/{raw_category}", response_model=CategoryClassMapOut)
async def assign_canonical_class(
    raw_category: str,
    body: ManualClassAssignment,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_any),
) -> CategoryClassMapOut:
    if body.canonical_class not in CANONICAL_CLASSES and body.canonical_class != UNCLASSIFIED:
        raise HTTPException(status_code=400, detail=f"Unknown canonical class '{body.canonical_class}'")

    row = (
        await db.execute(
            select(CategoryClassMap).where(CategoryClassMap.raw_category == raw_category)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="No mapping exists for that raw category yet")

    row.canonical_class = body.canonical_class
    row.match_method = ClassMatchMethod.MANUAL
    row.confidence = 1.0
    row.resolved_by = user.id
    await db.commit()
    await db.refresh(row)
    return CategoryClassMapOut.model_validate(row)

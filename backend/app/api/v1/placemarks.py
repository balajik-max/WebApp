"""Persistent, user-owned map placemarks."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from geoalchemy2.shape import from_shape
from shapely.geometry import Point
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import ActivityAction, ActivityLog, Dataset, Placemark, User
from app.schemas.placemark import (
    PlacemarkBulkDelete,
    PlacemarkBulkDeleteResult,
    PlacemarkCreate,
    PlacemarkOut,
    PlacemarkUpdate,
)

router = APIRouter()


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


async def _validate_dataset(db: AsyncSession, dataset_id: uuid.UUID | None) -> None:
    if dataset_id is None:
        return
    exists = await db.scalar(select(func.count()).select_from(Dataset).where(Dataset.id == dataset_id))
    if not exists:
        raise HTTPException(status_code=400, detail="Related dataset does not exist")


async def _owned_placemark(
    db: AsyncSession,
    placemark_id: uuid.UUID,
    owner_id: uuid.UUID,
) -> Placemark:
    row = await db.scalar(
        select(Placemark).where(
            Placemark.id == placemark_id,
            Placemark.owner_id == owner_id,
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Placemark not found")
    return row


@router.get("", response_model=list[PlacemarkOut])
async def list_placemarks(
    q: str | None = Query(default=None, max_length=255),
    dataset_id: uuid.UUID | None = None,
    include_hidden: bool = True,
    limit: int = Query(default=500, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PlacemarkOut]:
    statement = select(Placemark).where(Placemark.owner_id == current_user.id)
    if dataset_id is not None:
        statement = statement.where(Placemark.dataset_id == dataset_id)
    if not include_hidden:
        statement = statement.where(Placemark.is_visible.is_(True))
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        statement = statement.where(
            or_(
                Placemark.name.ilike(pattern),
                Placemark.description.ilike(pattern),
                Placemark.category.ilike(pattern),
            )
        )
    rows = (
        await db.execute(
            statement.order_by(Placemark.updated_at.desc()).offset(offset).limit(limit)
        )
    ).scalars().all()
    return [PlacemarkOut.model_validate(row) for row in rows]


@router.post("", response_model=PlacemarkOut, status_code=status.HTTP_201_CREATED)
async def create_placemark(
    body: PlacemarkCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PlacemarkOut:
    await _validate_dataset(db, body.dataset_id)
    row = Placemark(
        owner_id=current_user.id,
        dataset_id=body.dataset_id,
        name=body.name.strip(),
        description=_clean_optional(body.description),
        category=_clean_optional(body.category),
        icon=body.icon.strip(),
        longitude=body.longitude,
        latitude=body.latitude,
        altitude=body.altitude,
        is_visible=body.is_visible,
        geom=from_shape(Point(body.longitude, body.latitude), srid=4326),
    )
    db.add(row)
    await db.flush()
    db.add(
        ActivityLog(
            actor_id=current_user.id,
            action=ActivityAction.PLACEMARK_CREATED,
            entity_type="placemark",
            entity_id=row.id,
            payload={"name": row.name, "dataset_id": str(row.dataset_id) if row.dataset_id else None},
        )
    )
    return PlacemarkOut.model_validate(row)


@router.post("/bulk-delete", response_model=PlacemarkBulkDeleteResult)
async def bulk_delete_placemarks(
    body: PlacemarkBulkDelete,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PlacemarkBulkDeleteResult:
    ids = list(dict.fromkeys(body.ids))
    owned_ids = (
        await db.execute(
            select(Placemark.id).where(
                Placemark.owner_id == current_user.id,
                Placemark.id.in_(ids),
            )
        )
    ).scalars().all()
    if owned_ids:
        await db.execute(delete(Placemark).where(Placemark.id.in_(owned_ids)))
        for placemark_id in owned_ids:
            db.add(
                ActivityLog(
                    actor_id=current_user.id,
                    action=ActivityAction.PLACEMARK_DELETED,
                    entity_type="placemark",
                    entity_id=placemark_id,
                    payload={"bulk": True},
                )
            )
    return PlacemarkBulkDeleteResult(deleted=len(owned_ids))


@router.patch("/{placemark_id}", response_model=PlacemarkOut)
async def update_placemark(
    placemark_id: uuid.UUID,
    body: PlacemarkUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PlacemarkOut:
    row = await _owned_placemark(db, placemark_id, current_user.id)
    values = body.model_dump(exclude_unset=True)
    if "dataset_id" in values:
        await _validate_dataset(db, values["dataset_id"])

    if "name" in values and values["name"] is not None:
        values["name"] = values["name"].strip()
    for field in ("description", "category"):
        if field in values:
            values[field] = _clean_optional(values[field])
    if "icon" in values and values["icon"] is not None:
        values["icon"] = values["icon"].strip()

    next_longitude = values.get("longitude", row.longitude)
    next_latitude = values.get("latitude", row.latitude)
    for field, value in values.items():
        setattr(row, field, value)
    if "longitude" in values or "latitude" in values:
        row.geom = from_shape(Point(next_longitude, next_latitude), srid=4326)

    db.add(
        ActivityLog(
            actor_id=current_user.id,
            action=ActivityAction.PLACEMARK_UPDATED,
            entity_type="placemark",
            entity_id=row.id,
            payload={"changed_fields": sorted(values.keys())},
        )
    )
    await db.flush()
    return PlacemarkOut.model_validate(row)


@router.delete("/{placemark_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_placemark(
    placemark_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    row = await _owned_placemark(db, placemark_id, current_user.id)
    await db.delete(row)
    db.add(
        ActivityLog(
            actor_id=current_user.id,
            action=ActivityAction.PLACEMARK_DELETED,
            entity_type="placemark",
            entity_id=row.id,
            payload={"name": row.name},
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)

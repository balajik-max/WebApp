"""Read-only visualization manifest endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_any
from app.db.session import get_db
from app.schemas.visualization import VisualizationManifest
from app.services.visualization.manifest_builder import build_visualization_manifest


router = APIRouter()


@router.get(
    "/datasets/{dataset_id}/manifest",
    response_model=VisualizationManifest,
    dependencies=[Depends(require_any)],
    summary="Build a read-only visualization manifest for one dataset",
)
async def dataset_visualization_manifest(
    dataset_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> VisualizationManifest:
    return await build_visualization_manifest(dataset_id, db)
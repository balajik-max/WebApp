"""
Dataset upload + status endpoints.

The upload handler saves the file to MinIO synchronously (so the client
knows the bytes made it to durable storage) and then defers the actual
ingestion to a `BackgroundTasks` job.  The client is returned a 202 with
a `poll_url` immediately.

Endpoints mount under `/api/v1/datasets/*`.
"""
from __future__ import annotations

import io
import logging
import uuid
from datetime import date as date_type, datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_any
from app.core.config import MAX_UPLOAD_BYTES
from app.db.session import get_db
from app.models import (
    ActivityAction,
    ActivityLog,
    Dataset,
    DatasetFileType,
    DatasetStatus,
    Feature,
    User,
)
from app.schemas.dataset import DatasetOut, DatasetUpdate, DatasetUploadAccepted, WardOption
from app.services.ingestion import ingest_dataset
from app.services.readers import get_reader_for
from app.services.storage import delete_object, ensure_bucket, upload_stream

log = logging.getLogger("davangere.api.datasets")
router = APIRouter()

# Hard cap so a single upload can't exhaust worker memory. GDAL/geopandas
# reads the whole file into memory downstream, so this must stay well
# under available container RAM regardless of how many workers run.
# Shared with SecurityMiddleware's body-size check (app/core/config.py)
# so the two limits can never drift out of sync again.
_MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES


# Suffix → declared file_type mapping used to persist a stable enum value.
_SUFFIX_TO_TYPE: dict[str, DatasetFileType] = {
    ".geojson": DatasetFileType.GEOJSON,
    ".json": DatasetFileType.GEOJSON,
    ".shp": DatasetFileType.SHAPEFILE,
    ".zip": DatasetFileType.SHAPEFILE,   # zipped shapefile bundles
    ".kml": DatasetFileType.KML,
    ".csv": DatasetFileType.CSV,
    ".tsv": DatasetFileType.CSV,
    ".xlsx": DatasetFileType.CSV,        # tabular family; readers dispatch on extension
    ".xls": DatasetFileType.CSV,
    ".tif": DatasetFileType.GEOTIFF,
    ".tiff": DatasetFileType.GEOTIFF,
    ".geotiff": DatasetFileType.GEOTIFF,
    ".obj": DatasetFileType.OTHER,       # 3D model
    ".gdb": DatasetFileType.SHAPEFILE,   # Esri File Geodatabase
}


def _classify(filename: str) -> DatasetFileType:
    return _SUFFIX_TO_TYPE.get(Path(filename).suffix.lower(), DatasetFileType.OTHER)


@router.post(
    "/upload",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=DatasetUploadAccepted,
    dependencies=[Depends(require_any)],
)
async def upload_dataset(
    background_tasks: BackgroundTasks,
    response: Response,
    file: UploadFile = File(..., description="Shapefile (.zip/.shp), .geojson, .csv, .xlsx"),
    name: str = Form(..., min_length=1, max_length=255),
    description: str | None = Form(default=None, max_length=1024),
    ward: str | None = Form(default=None, max_length=128),
    survey_date: date_type | None = Form(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DatasetUploadAccepted:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Uploaded file has no filename")

    # Reject files no reader can handle up-front so the caller gets a
    # deterministic 400 instead of a queued-then-failed dataset row.
    if get_reader_for(file.filename) is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file extension for '{file.filename}'",
        )

    # 1. Buffer the payload (UploadFile streams from a SpooledTemporaryFile).
    #    Bounded read: request at most one byte over the cap so an oversized
    #    upload is rejected without ever materializing the full file in memory.
    payload = await file.read(_MAX_UPLOAD_BYTES + 1)
    if len(payload) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds the {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit",
        )
    size_bytes = len(payload)
    if size_bytes == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    # Basic magic-byte validation for common file types
    ext = Path(file.filename).suffix.lower()
    _validate_file_magic(payload, ext)

    # 2. Ensure the bucket exists (idempotent) then push the object.
    await ensure_bucket()

    dataset_id = uuid.uuid4()
    storage_key = f"datasets/{dataset_id}/{file.filename}"
    await upload_stream(
        io.BytesIO(payload),
        key=storage_key,
        content_type=file.content_type,
    )

    # 3. Persist a `datasets` row in QUEUED state + activity log.
    ds = Dataset(
        id=dataset_id,
        name=name,
        description=description,
        ward=ward,
        survey_date=survey_date,
        file_type=_classify(file.filename),
        storage_key=storage_key,
        size_bytes=size_bytes,
        status=DatasetStatus.QUEUED,
        dataset_metadata={
            "original_filename": file.filename,
            "content_type": file.content_type,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
        },
        uploaded_by=current_user.id,
    )
    db.add(ds)
    db.add(
        ActivityLog(
            actor_id=current_user.id,
            action=ActivityAction.DATASET_UPLOADED,
            entity_type="dataset",
            entity_id=dataset_id,
            payload={
                "filename": file.filename,
                "size_bytes": size_bytes,
                "storage_key": storage_key,
            },
        )
    )
    await db.flush()  # ensure row is visible to the background task

    # 4. Fire-and-forget the ingestion pipeline.
    background_tasks.add_task(
        ingest_dataset,
        dataset_id=dataset_id,
        storage_key=storage_key,
        filename=file.filename,
    )

    poll_url = f"/api/v1/datasets/{dataset_id}"
    response.headers["Location"] = poll_url
    return DatasetUploadAccepted(
        dataset=DatasetOut.model_validate(ds),
        poll_url=poll_url,
    )


@router.get(
    "/{dataset_id}",
    response_model=DatasetOut,
    dependencies=[Depends(require_any)],
)
async def get_dataset(dataset_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> DatasetOut:
    row = (await db.execute(select(Dataset).where(Dataset.id == dataset_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return DatasetOut.model_validate(row)


@router.get(
    "/{dataset_id}/raster-preview.png",
    dependencies=[Depends(require_any)],
)
async def get_raster_preview(dataset_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> Response:
    """Streams the reprojected raster preview PNG generated at ingestion
    time. Proxied through the API (rather than a presigned MinIO URL)
    because the storage endpoint is an internal Docker hostname the
    browser can't resolve directly."""
    row = (await db.execute(select(Dataset).where(Dataset.id == dataset_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    overlay = (row.dataset_metadata or {}).get("raster_overlay")
    if not overlay or not overlay.get("image_key"):
        raise HTTPException(status_code=404, detail="No raster preview available for this dataset")

    from app.services.storage import get_object_bytes

    try:
        png_bytes = await get_object_bytes(overlay["image_key"])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Raster preview not found in storage") from exc

    return Response(content=png_bytes, media_type="image/png")


@router.patch(
    "/{dataset_id}",
    response_model=DatasetOut,
    dependencies=[Depends(require_any)],
)
async def update_dataset(
    dataset_id: uuid.UUID,
    body: DatasetUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DatasetOut:
    row = (await db.execute(select(Dataset).where(Dataset.id == dataset_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(row, field, value)

    if changes:
        db.add(
            ActivityLog(
                actor_id=current_user.id,
                action=ActivityAction.DATASET_STATUS_CHANGED,
                entity_type="dataset",
                entity_id=dataset_id,
                payload={"updated_fields": changes},
            )
        )
    await db.commit()
    await db.refresh(row)
    return DatasetOut.model_validate(row)


@router.get(
    "/wards/list",
    response_model=list[WardOption],
    dependencies=[Depends(require_any)],
)
async def list_wards(db: AsyncSession = Depends(get_db)) -> list[WardOption]:
    rows = (
        await db.execute(
            select(
                Dataset.ward,
                func.count(func.distinct(Dataset.id)),
                func.count(Feature.id),
            )
            .outerjoin(Feature, Feature.dataset_id == Dataset.id)
            .where(Dataset.ward.isnot(None), Dataset.ward != "")
            .group_by(Dataset.ward)
            .order_by(Dataset.ward)
        )
    ).all()
    return [
        WardOption(ward=r[0], dataset_count=int(r[1]), feature_count=int(r[2]))
        for r in rows
    ]


@router.delete(
    "/{dataset_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_any)],
)
async def delete_dataset(
    dataset_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    row = (await db.execute(select(Dataset).where(Dataset.id == dataset_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    if row.storage_key:
        await delete_object(row.storage_key)

    db.add(
        ActivityLog(
            actor_id=current_user.id,
            action=ActivityAction.DATASET_DELETED,
            entity_type="dataset",
            entity_id=dataset_id,
            payload={"name": row.name, "storage_key": row.storage_key},
        )
    )
    await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/{dataset_id}/features",
    dependencies=[Depends(require_any)],
    summary="Paginated attribute table for a dataset's ingested features",
)
async def dataset_feature_table(
    dataset_id: uuid.UUID,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    exists = (
        await db.execute(select(Dataset.id).where(Dataset.id == dataset_id))
    ).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    total = (
        await db.execute(
            select(func.count(Feature.id)).where(Feature.dataset_id == dataset_id)
        )
    ).scalar_one()

    rows = (
        await db.execute(
            select(Feature)
            .where(Feature.dataset_id == dataset_id)
            .order_by(Feature.created_at)
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()

    # Column set = union of attribute keys seen on this page, alphabetical.
    columns: set[str] = set()
    for r in rows:
        columns.update(r.attributes.keys())

    return {
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "columns": sorted(columns),
        "rows": [
            {
                "id": str(r.id),
                "label": r.label,
                "category": r.category,
                "severity": r.severity,
                "attributes": r.attributes,
            }
            for r in rows
        ],
    }


@router.get(
    "/{dataset_id}/bounds",
    dependencies=[Depends(require_any)],
    summary="Bounding box of a dataset's ingested features, for map fly-to",
)
async def dataset_bounds(
    dataset_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    exists = (
        await db.execute(select(Dataset.id).where(Dataset.id == dataset_id))
    ).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    row = (
        await db.execute(
            text(
                """
                SELECT
                    ST_XMin(ext) AS min_lon, ST_YMin(ext) AS min_lat,
                    ST_XMax(ext) AS max_lon, ST_YMax(ext) AS max_lat
                FROM (SELECT ST_Extent(geom) AS ext FROM features WHERE dataset_id = :id) t
                """
            ),
            {"id": str(dataset_id)},
        )
    ).mappings().first()

    if row is None or row["min_lon"] is None:
        raise HTTPException(status_code=404, detail="Dataset has no ingested features")

    return {
        "min_lon": row["min_lon"],
        "min_lat": row["min_lat"],
        "max_lon": row["max_lon"],
        "max_lat": row["max_lat"],
    }


# Magic-byte signatures for file type validation
_MAGIC: dict[str, list[bytes]] = {
    ".geojson": [b"{", b"["],
    ".json": [b"{", b"["],
    ".csv": [],
    ".tsv": [],
    ".xlsx": [b"PK\x03\x04"],
    ".xls": [b"\xD0\xCF\x11\xE0"],
    ".zip": [b"PK\x03\x04"],
    ".kml": [b"<"],
    ".gpkg": [b"GP"],
    # Classic TIFF (little/big-endian) plus BigTIFF (little/big-endian) —
    # large real-world GeoTIFFs (DEMs, orthomosaics) are frequently written
    # as BigTIFF, which has a different magic number (0x2B instead of 0x2A).
    ".tif": [b"II\x2a\x00", b"MM\x00\x2a", b"II\x2b\x00", b"MM\x00\x2b"],
    ".tiff": [b"II\x2a\x00", b"MM\x00\x2a", b"II\x2b\x00", b"MM\x00\x2b"],
    ".geotiff": [b"II\x2a\x00", b"MM\x00\x2a", b"II\x2b\x00", b"MM\x00\x2b"],
    ".obj": [b"#", b"v ", b"vt ", b"vn ", b"vp ", b"f ", b"o ", b"g ", b"s ", b"mtllib", b"usemtl"],
}
_MAX_MAGIC_BYTES = 256
# OBJ is a line-oriented text format with many valid leading directives
# (comments, object/group names, material refs) before any vertex/face
# data — unlike the binary formats above, its "signature" can appear
# anywhere in the head, not just at byte 0.
_CONTAINS_ANYWHERE = {".obj"}


def _validate_file_magic(payload: bytes, ext: str) -> None:
    sigs = _MAGIC.get(ext)
    if sigs is None or not sigs:
        return
    head = payload[:_MAX_MAGIC_BYTES]
    if ext in _CONTAINS_ANYWHERE:
        matched = any(sig in head for sig in sigs)
    else:
        matched = any(head.startswith(sig) for sig in sigs)
    if not matched:
        raise HTTPException(
            status_code=400,
            detail=f"File content does not match expected format for '{ext}' extension",
        )


@router.get(
    "",
    response_model=list[DatasetOut],
    dependencies=[Depends(require_any)],
)
async def list_datasets(
    db: AsyncSession = Depends(get_db),
    limit: int = 50,
    offset: int = 0,
) -> list[DatasetOut]:
    limit = max(1, min(200, limit))
    offset = max(0, offset)
    rows = (
        await db.execute(
            select(Dataset).order_by(Dataset.created_at.desc()).limit(limit).offset(offset)
        )
    ).scalars().all()
    return [DatasetOut.model_validate(r) for r in rows]

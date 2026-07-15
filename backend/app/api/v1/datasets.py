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
import mimetypes
import uuid
from datetime import date as date_type, datetime, timezone
from pathlib import Path
from typing import Any, Literal

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
from starlette.responses import StreamingResponse

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
from app.services.attribute_table import (
    order_attribute_columns,
    populated_attribute_column_count,
    resolve_feature_fid,
)
from app.services.ingestion import ingest_dataset
from app.services.readers import get_reader_for
from app.services.storage import delete_object, delete_objects_with_prefix, ensure_bucket, upload_stream

log = logging.getLogger("davangere.api.datasets")
router = APIRouter()

# Hard cap so a single upload can't exhaust worker memory. GDAL/geopandas
# reads the whole file into memory downstream, so this must stay well
# under available container RAM regardless of how many workers run.
# Shared with SecurityMiddleware's body-size check (app/core/config.py)
# so the two limits can never drift out of sync again.
_MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES


def _render_preview_variant(png_bytes: bytes, *, mode: Literal["rgb", "grayscale", "enhanced"]) -> bytes:
    """Transform stored preview PNGs into display variants on demand.

    Single-band raster previews are stored as grayscale+alpha. For those,
    `rgb` returns a terrain-style colorized overlay so DTM/DSM rasters are
    visibly distinct from grayscale mode. For true-color previews, `rgb`
    returns the original image and `grayscale` desaturates it.
    """
    import numpy as np
    from rasterio.io import MemoryFile

    with MemoryFile(png_bytes) as memfile:
        with memfile.open() as src:
            data = src.read()

    band_count = data.shape[0]
    if band_count < 2:
        return png_bytes

    alpha = data[-1]

    if band_count == 2:
        gray = data[0].astype(np.float32)
        if mode == "grayscale":
            return png_bytes

        # Global Mapper rainbow palette: Blue -> Cyan -> Green -> Yellow -> Orange -> Red
        stops = np.array([0.0, 0.2, 0.4, 0.6, 0.8, 1.0], dtype=np.float32)
        palette = np.array(
            [
                [0,   0,   255],  # Blue   (low elevation)
                [0,   255, 255],  # Cyan
                [0,   255, 0],    # Green
                [255, 255, 0],    # Yellow
                [255, 127, 0],    # Orange
                [255, 0,   0],    # Red    (high elevation)
            ],
            dtype=np.float32,
        )
        normalized = gray / 255.0
        r = np.interp(normalized, stops, palette[:, 0])
        g = np.interp(normalized, stops, palette[:, 1])
        b = np.interp(normalized, stops, palette[:, 2])

        if mode == "enhanced":
            try:
                # 3D hillshading — Azimuth 315°, Altitude 45° (same as Global Mapper default)
                dy, dx = np.gradient(gray)
                z = 2.0  # z-factor: amplifies height differences for visible shading
                slope = np.pi / 2.0 - np.arctan(np.sqrt((dx * z) ** 2 + (dy * z) ** 2))
                aspect = np.arctan2(-dy, dx)
                az = 315.0 * np.pi / 180.0
                alt = 45.0 * np.pi / 180.0
                intensity = (
                    np.sin(alt) * np.sin(slope)
                    + np.cos(alt) * np.cos(slope) * np.cos((az - np.pi / 2.0) - aspect)
                )
                intensity = np.clip(intensity, 0.0, 1.0)
                # Normalize so mid-slope terrain keeps its colour brightness
                blend = intensity / np.sin(alt)
                r = np.clip(r * blend, 0, 255)
                g = np.clip(g * blend, 0, 255)
                b = np.clip(b * blend, 0, 255)
            except Exception:  # noqa: BLE001
                pass  # fallback: show plain rainbow without shading

        rgb = np.stack([r, g, b], axis=0).astype(np.uint8)
    else:
        rgb_src = data[:3].astype(np.float32)
        if mode == "rgb":
            return png_bytes
        luminance = (
            0.2126 * rgb_src[0]
            + 0.7152 * rgb_src[1]
            + 0.0722 * rgb_src[2]
        ).astype(np.uint8)
        rgb = np.stack([luminance, luminance, luminance], axis=0)

    stacked = np.vstack([rgb, alpha[np.newaxis, :, :]])
    height, width = alpha.shape
    with MemoryFile() as out_memfile:
        with out_memfile.open(
            driver="PNG",
            height=height,
            width=width,
            count=4,
            dtype="uint8",
        ) as dst:
            dst.write(stacked)
        return out_memfile.read()


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
    ".jpg": DatasetFileType.IMAGE,
    ".jpeg": DatasetFileType.IMAGE,
    ".png": DatasetFileType.IMAGE,
    ".gif": DatasetFileType.IMAGE,
    ".bmp": DatasetFileType.IMAGE,
    ".webp": DatasetFileType.IMAGE,
}

_ZIP_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}
_ZIP_GIS_EXTS = {".shp", ".dbf", ".shx", ".prj", ".gpkg"}
_ZIP_OBJ_EXTS = {".obj"}


def _validate_zipped_shapefile(payload: bytes) -> None:
    """Require a complete, unambiguous shapefile before queueing ingestion."""
    import zipfile
    from pathlib import PurePosixPath

    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            names = [name.replace("\\", "/") for name in zf.namelist() if not name.endswith("/")]
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Uploaded ZIP file is invalid") from exc

    shp_names = [name for name in names if PurePosixPath(name).suffix.lower() == ".shp"]
    if not shp_names:
        return
    if len(shp_names) != 1:
        raise HTTPException(
            status_code=400,
            detail="A shapefile ZIP must contain exactly one .shp file",
        )

    shp_path = PurePosixPath(shp_names[0])
    members = {name.casefold() for name in names}
    required = (".dbf", ".shx", ".prj")
    missing = [suffix for suffix in required if str(shp_path.with_suffix(suffix)).casefold() not in members]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Shapefile ZIP is missing required companion file(s): {', '.join(missing)}",
        )


def _classify(filename: str, payload: bytes | None = None) -> DatasetFileType:
    ext = Path(filename).suffix.lower()
    if ext == ".zip" and payload:
        # A zip could be a shapefile/GDB bundle, a batch of geo-tagged
        # photos, or a 3D model bundle (.obj + .mtl + textures) — peek at
        # its real contents rather than assuming, so the dataset row's
        # declared type matches what actually got ingested.
        import zipfile

        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as zf:
                names = [n for n in zf.namelist() if not n.endswith("/")]
            if any(Path(n).suffix.lower() in _ZIP_OBJ_EXTS for n in names):
                return DatasetFileType.OTHER
            if not any(Path(n).suffix.lower() in _ZIP_GIS_EXTS or ".gdb/" in n.lower() for n in names):
                if any(Path(n).suffix.lower() in _ZIP_IMAGE_EXTS for n in names):
                    return DatasetFileType.IMAGE
        except zipfile.BadZipFile:
            pass
    return _SUFFIX_TO_TYPE.get(ext, DatasetFileType.OTHER)


@router.post(
    "/upload",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=DatasetUploadAccepted,
    dependencies=[Depends(require_any)],
)
async def upload_dataset(
    background_tasks: BackgroundTasks,
    response: Response,
    file: UploadFile = File(..., description="GIS, raster, tabular, photo, or OBJ/OBJ bundle"),
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
    if ext == ".shp":
        raise HTTPException(
            status_code=400,
            detail="Upload the .shp together with its .dbf, .shx, and .prj files as one ZIP",
        )
    if ext == ".zip":
        _validate_zipped_shapefile(payload)

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
        file_type=_classify(file.filename, payload),
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
async def get_raster_preview(
    dataset_id: uuid.UUID,
    mode: Literal["rgb", "grayscale", "enhanced"] = Query("grayscale"),
    db: AsyncSession = Depends(get_db),
) -> Response:
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

    png_bytes = _render_preview_variant(png_bytes, mode=mode)
    return Response(content=png_bytes, media_type="image/png")


@router.get(
    "/{dataset_id}/raw-file",
    dependencies=[Depends(require_any)],
)
async def get_raw_file(dataset_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> Response:
    """Streams the raw `.obj`/source file bytes. Used by format-specific
    client-side viewers (e.g. the 3D OBJ viewer) that need the raw source
    rather than the ingested/derived features.

    If the dataset was uploaded as a zip bundle (.obj + .mtl + textures),
    `storage_key` points at the *zip*, not the model itself — the reader
    extracted and re-uploaded the `.obj` separately under
    `dataset_metadata.model_assets.obj_key`, which is what's served here."""
    row = (await db.execute(select(Dataset).where(Dataset.id == dataset_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    model_assets = (row.dataset_metadata or {}).get("model_assets")
    key = (model_assets or {}).get("obj_key") or row.storage_key
    if not key:
        raise HTTPException(status_code=404, detail="No source file stored for this dataset")

    from app.services.storage import get_object_bytes

    try:
        raw_bytes = await get_object_bytes(key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Source file not found in storage") from exc

    return Response(content=raw_bytes, media_type="application/octet-stream")


@router.get(
    "/{dataset_id}/model-asset/{filename}",
    dependencies=[Depends(require_any)],
)
async def get_model_asset(dataset_id: uuid.UUID, filename: str, db: AsyncSession = Depends(get_db)) -> Response:
    """Streams one companion file (the `.mtl` or a texture image) from an
    OBJ zip bundle, so the 3D viewer can load the model's real materials
    instead of a flat placeholder color."""
    row = (await db.execute(select(Dataset).where(Dataset.id == dataset_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    model_assets = (row.dataset_metadata or {}).get("model_assets") or {}
    key: str | None = None
    if filename == model_assets.get("mtl_filename"):
        key = model_assets.get("mtl_key")
    else:
        key = (model_assets.get("textures") or {}).get(filename)
    if not key:
        raise HTTPException(status_code=404, detail=f"No such model asset: {filename}")

    from app.services.storage import get_object_bytes

    try:
        asset_bytes = await get_object_bytes(key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Asset not found in storage") from exc

    content_type, _ = mimetypes.guess_type(filename)
    return Response(content=asset_bytes, media_type=content_type or "application/octet-stream")


@router.get(
    "/{dataset_id}/model-assets/{asset_path:path}",
    dependencies=[Depends(require_any)],
)
async def get_model_asset_by_path(
    dataset_id: uuid.UUID,
    asset_path: str,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Streams an OBJ/MTL/texture asset by its path key, for consumers that
    address assets via `dataset_metadata.model_3d.asset_keys` (path-based)
    rather than the flat `model-asset/{filename}` lookup above."""
    row = (await db.execute(select(Dataset).where(Dataset.id == dataset_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    model_metadata = (row.dataset_metadata or {}).get("model_3d") or {}
    asset_keys = model_metadata.get("asset_keys") or {}
    storage_key = asset_keys.get(asset_path)
    if not storage_key:
        raise HTTPException(status_code=404, detail="Model asset not found")

    from app.services.storage import open_object_stream

    try:
        object_response = await open_object_stream(storage_key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Model asset not found in storage") from exc

    body = object_response["Body"]

    def chunks():
        try:
            yield from body.iter_chunks(chunk_size=1024 * 1024)
        finally:
            body.close()

    headers = {"Cache-Control": "private, max-age=3600"}
    content_length = object_response.get("ContentLength")
    if content_length is not None:
        headers["Content-Length"] = str(content_length)
    return StreamingResponse(
        chunks(),
        media_type=object_response.get("ContentType") or "application/octet-stream",
        headers=headers,
    )


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
    # OBJ bundles re-upload their .obj/.mtl/textures individually under this
    # prefix (see ObjReader._upload_model_assets) — clean those up too, or
    # they'd otherwise outlive the dataset row that referenced them.
    await delete_objects_with_prefix(f"datasets/{dataset_id}/model/")

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
            .order_by(Feature.created_at, Feature.id)
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()

    # Rank fields by actual data coverage across the complete dataset. This
    # keeps populated survey readings at the front and moves fields that are
    # entirely null/blank to the far right, consistently on every page.
    # Leading-underscore keys (e.g. _canonical_class) are internal spatial
    # audit engine bookkeeping, not survey attributes — never surface them
    # in the user-facing attribute table.
    column_rows = (
        await db.execute(
            text(
                """
                SELECT
                    keys.attribute_key,
                    COUNT(*) FILTER (
                        WHERE keys.attribute_value NOT IN (
                            'null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb
                        )
                    ) AS populated_count
                FROM features f
                CROSS JOIN LATERAL jsonb_each(
                    COALESCE(f.attributes, '{}'::jsonb)
                ) AS keys(attribute_key, attribute_value)
                WHERE f.dataset_id = :dataset_id
                GROUP BY keys.attribute_key
                """
            ),
            {"dataset_id": dataset_id},
        )
    ).all()
    column_rows = [row for row in column_rows if not row[0].startswith("_")]

    return {
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "columns": order_attribute_columns(column_rows),
        "populated_column_count": populated_attribute_column_count(column_rows),
        "rows": [
            {
                "id": str(r.id),
                "fid": resolve_feature_fid(r.attributes, offset + index + 1),
                "label": r.label,
                "category": r.category,
                "severity": r.severity,
                "attributes": r.attributes,
            }
            for index, r in enumerate(rows)
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
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".gif": [b"GIF87a", b"GIF89a"],
    ".bmp": [b"BM"],
    ".webp": [b"WEBP"],  # actual prefix is "RIFF"+size+"WEBP" — checked via _CONTAINS_ANYWHERE below
}
_MAX_MAGIC_BYTES = 256
# OBJ is a line-oriented text format with many valid leading directives
# (comments, object/group names, material refs) before any vertex/face
# data — unlike the binary formats above, its "signature" can appear
# anywhere in the head, not just at byte 0. WEBP's "WEBP" marker sits at
# a fixed offset (8) after the RIFF header/size, not at byte 0 either.
_CONTAINS_ANYWHERE = {".obj", ".webp"}


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

"""Citizen-owned dataset upload and read-only map endpoints.

These endpoints intentionally use ``public_datasets`` and
``public_dataset_features`` rather than the officer tables. This keeps public
uploads out of officer maps, analytics, layer review, AI audits and workflows.
"""
from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.public_deps import get_current_public_user
from app.api.v1.datasets import _MAX_UPLOAD_BYTES, _validate_file_magic, _validate_zipped_shapefile
from app.db.session import get_db
from app.models import DatasetFileType, DatasetStatus, PublicDataset, PublicUser
from app.schemas.public_portal import (
    PublicDatasetBoundsOut,
    PublicDatasetLayerOut,
    PublicDatasetOut,
    PublicDatasetUploadAccepted,
)
from app.services.public_dataset_ingestion import ingest_public_dataset
from app.services.storage import delete_object, ensure_bucket, upload_stream

router = APIRouter()
_SUPPORTED_EXTENSIONS = {".geojson", ".json", ".zip", ".gpkg", ".kml"}
_MAX_ZIP_MEMBERS = 25000
_MAX_ZIP_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024


def _safe_upload_filename(filename: str) -> str:
    normalized = filename.replace("\\", "/")
    safe = PurePosixPath(normalized).name.strip()
    if not safe or safe in {".", ".."}:
        raise HTTPException(status_code=400, detail="Uploaded file has an invalid filename")
    return safe


def _inspect_zip(payload: bytes) -> tuple[list[str], set[str]]:
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            infos = [info for info in archive.infolist() if not info.is_dir()]
            if len(infos) > _MAX_ZIP_MEMBERS:
                raise HTTPException(status_code=400, detail="ZIP contains too many files")
            if sum(info.file_size for info in infos) > _MAX_ZIP_UNCOMPRESSED_BYTES:
                raise HTTPException(status_code=400, detail="ZIP expands beyond the public upload safety limit")
            names: list[str] = []
            gdb_roots: set[str] = set()
            for info in infos:
                name = info.filename.replace("\\", "/")
                path = PurePosixPath(name)
                if path.is_absolute() or ".." in path.parts:
                    raise HTTPException(status_code=400, detail="ZIP contains an unsafe file path")
                names.append(name)
                parts: list[str] = []
                for part in path.parts:
                    parts.append(part)
                    if part.casefold().endswith(".gdb"):
                        gdb_roots.add("/".join(parts))
                        break
            return names, gdb_roots
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Uploaded ZIP file is invalid") from exc


def _dataset_file_type(filename: str) -> DatasetFileType:
    extension = Path(filename).suffix.casefold()
    if extension in {".geojson", ".json"}:
        return DatasetFileType.GEOJSON
    if extension == ".kml":
        return DatasetFileType.KML
    if extension == ".gpkg":
        return DatasetFileType.OTHER
    if extension == ".zip":
        return DatasetFileType.SHAPEFILE
    return DatasetFileType.OTHER


def _validate_public_vector_file(filename: str, payload: bytes) -> None:
    extension = Path(filename).suffix.casefold()
    if extension not in _SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Public map uploads support GeoJSON, KML, GeoPackage, zipped Shapefile, and zipped File Geodatabase (.gdb).",
        )
    _validate_file_magic(payload, extension)
    if extension != ".zip":
        return

    names, gdb_roots = _inspect_zip(payload)
    shapefiles = [name for name in names if PurePosixPath(name).suffix.casefold() == ".shp"]
    if len(gdb_roots) > 1:
        raise HTTPException(status_code=400, detail="ZIP must contain only one File Geodatabase (.gdb) folder")
    if gdb_roots:
        return
    if not shapefiles:
        raise HTTPException(
            status_code=400,
            detail="ZIP must contain one complete Shapefile or one File Geodatabase (.gdb) folder.",
        )
    _validate_zipped_shapefile(payload)


async def _owned_dataset(db: AsyncSession, dataset_id: uuid.UUID, public_user_id: uuid.UUID) -> PublicDataset:
    row = (
        await db.execute(
            select(PublicDataset).where(
                PublicDataset.id == dataset_id,
                PublicDataset.public_user_id == public_user_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return row


@router.post(
    "/datasets/upload",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=PublicDatasetUploadAccepted,
)
async def upload_public_dataset(
    background_tasks: BackgroundTasks,
    response: Response,
    file: UploadFile = File(...),
    name: str = Form(..., min_length=1, max_length=255),
    description: str | None = Form(default=None, max_length=1024),
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> PublicDatasetUploadAccepted:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Uploaded file has no filename")

    payload = await file.read(_MAX_UPLOAD_BYTES + 1)
    if len(payload) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds the {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit",
        )
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    _validate_public_vector_file(file.filename, payload)

    normalized_name = " ".join(name.split())
    if not normalized_name:
        raise HTTPException(status_code=422, detail="Dataset name cannot be blank")

    await ensure_bucket()
    dataset_id = uuid.uuid4()
    safe_filename = _safe_upload_filename(file.filename)
    storage_key = f"public-datasets/{public_user.id}/{dataset_id}/{safe_filename}"
    await upload_stream(io.BytesIO(payload), key=storage_key, content_type=file.content_type)

    row = PublicDataset(
        id=dataset_id,
        public_user_id=public_user.id,
        name=normalized_name,
        description=(description.strip() or None) if description else None,
        file_type=_dataset_file_type(safe_filename),
        storage_key=storage_key,
        size_bytes=len(payload),
        status=DatasetStatus.QUEUED,
        dataset_metadata={
            "original_filename": safe_filename,
            "content_type": file.content_type,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
            "scope": "public_user_owned",
        },
    )
    db.add(row)
    await db.flush()

    background_tasks.add_task(
        ingest_public_dataset,
        dataset_id=dataset_id,
        storage_key=storage_key,
        filename=safe_filename,
    )
    poll_url = f"/api/public/datasets/{dataset_id}"
    response.headers["Location"] = poll_url
    return PublicDatasetUploadAccepted(dataset=PublicDatasetOut.model_validate(row), poll_url=poll_url)


@router.get("/datasets", response_model=list[PublicDatasetOut])
async def list_public_datasets(
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> list[PublicDatasetOut]:
    rows = (
        await db.execute(
            select(PublicDataset)
            .where(PublicDataset.public_user_id == public_user.id)
            .order_by(PublicDataset.created_at.desc())
        )
    ).scalars().all()
    return [PublicDatasetOut.model_validate(row) for row in rows]


@router.get("/datasets/{dataset_id}", response_model=PublicDatasetOut)
async def get_public_dataset(
    dataset_id: uuid.UUID,
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> PublicDatasetOut:
    return PublicDatasetOut.model_validate(await _owned_dataset(db, dataset_id, public_user.id))


@router.delete("/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_public_dataset(
    dataset_id: uuid.UUID,
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    row = await _owned_dataset(db, dataset_id, public_user.id)
    if row.storage_key:
        await delete_object(row.storage_key)
    await db.delete(row)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/datasets/{dataset_id}/layers", response_model=list[PublicDatasetLayerOut])
async def list_public_dataset_layers(
    dataset_id: uuid.UUID,
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> list[PublicDatasetLayerOut]:
    await _owned_dataset(db, dataset_id, public_user.id)
    rows = (
        await db.execute(
            text(
                """
                SELECT
                    COALESCE(NULLIF(BTRIM(attributes ->> 'gdb_layer'), ''),
                             NULLIF(BTRIM(category), ''), 'Uncategorized') AS layer_name,
                    COUNT(*)::bigint AS feature_count
                FROM public_dataset_features
                WHERE public_dataset_id = :dataset_id
                GROUP BY layer_name
                ORDER BY layer_name
                """
            ),
            {"dataset_id": dataset_id},
        )
    ).mappings().all()
    return [
        PublicDatasetLayerOut(name=str(row["layer_name"]), feature_count=int(row["feature_count"]))
        for row in rows
    ]


@router.get("/datasets/{dataset_id}/bounds", response_model=PublicDatasetBoundsOut)
async def public_dataset_bounds(
    dataset_id: uuid.UUID,
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> PublicDatasetBoundsOut:
    await _owned_dataset(db, dataset_id, public_user.id)
    row = (
        await db.execute(
            text(
                """
                SELECT
                    ST_XMin(ext) AS min_lon, ST_YMin(ext) AS min_lat,
                    ST_XMax(ext) AS max_lon, ST_YMax(ext) AS max_lat
                FROM (
                    SELECT ST_Extent(geom) AS ext
                    FROM public_dataset_features
                    WHERE public_dataset_id = :dataset_id
                ) AS bounds
                """
            ),
            {"dataset_id": dataset_id},
        )
    ).mappings().first()
    if row is None or row["min_lon"] is None:
        raise HTTPException(status_code=404, detail="Dataset has no map features")
    return PublicDatasetBoundsOut(**{key: float(row[key]) for key in ("min_lon", "min_lat", "max_lon", "max_lat")})


@router.get("/datasets/{dataset_id}/features")
async def public_dataset_features(
    dataset_id: uuid.UUID,
    layer: list[str] | None = Query(default=None),
    limit: int = Query(default=50000, ge=1, le=100000),
    public_user: PublicUser = Depends(get_current_public_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await _owned_dataset(db, dataset_id, public_user.id)
    conditions = ["public_dataset_id = :dataset_id"]
    params: dict[str, Any] = {"dataset_id": dataset_id, "limit": limit}
    if layer:
        normalized = list(dict.fromkeys(value.strip() for value in layer if value.strip()))
        if normalized:
            conditions.append(
                "COALESCE(NULLIF(BTRIM(attributes ->> 'gdb_layer'), ''), "
                "NULLIF(BTRIM(category), ''), 'Uncategorized') = ANY(CAST(:layers AS text[]))"
            )
            params["layers"] = normalized
    where_clause = " AND ".join(conditions)
    rows = (
        await db.execute(
            text(
                f"""
                SELECT
                    id::text AS id,
                    label,
                    category,
                    COALESCE(attributes, '{{}}'::jsonb) AS attributes,
                    ST_AsGeoJSON(geom)::text AS geometry_json
                FROM public_dataset_features
                WHERE {where_clause}
                ORDER BY created_at, id
                LIMIT :limit
                """
            ),
            params,
        )
    ).mappings().all()

    features = []
    for row in rows:
        attributes = dict(row["attributes"] or {})
        layer_name = attributes.get("gdb_layer") or row["category"] or "Uncategorized"
        features.append(
            {
                "type": "Feature",
                "id": row["id"],
                "geometry": json.loads(row["geometry_json"]) if row["geometry_json"] else None,
                "properties": {
                    "id": row["id"],
                    "dataset_id": str(dataset_id),
                    "label": row["label"],
                    "category": row["category"] or "Uncategorized",
                    "source_layer": str(layer_name),
                    "attributes": attributes,
                },
            }
        )
    return {
        "type": "FeatureCollection",
        "features": features,
        "count": len(features),
        "limit": limit,
        "truncated": len(features) >= limit,
    }

"""Generate a new resolved File Geodatabase without mutating the uploaded source.

The exported GDB preserves every readable source layer and geometry, updates
``Condition`` only for Admin-approved features, and adds audit fields that keep
both the original and verified conditions visible.
"""
from __future__ import annotations

import asyncio
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Iterable

import geopandas as gpd
import pyogrio

from app.models.dataset import Dataset
from app.services.storage import download_to_file


@dataclass(frozen=True, slots=True)
class ResolvedGdbRecord:
    verification_id: str
    feature_id: str
    source_layer: str
    source_fid: object
    original_condition: str | None
    verified_condition: str
    architect_name: str | None
    work_completed: str | None
    work_completed_at: datetime | None
    admin_name: str | None
    resolved_at: datetime | None
    admin_remarks: str | None
    location_status: str | None
    anomaly_id: str | None


def _normalise_fid(value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    try:
        number = float(text)
        if number.is_integer():
            return str(int(number))
    except (TypeError, ValueError):
        pass
    return text


def _safe_component(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()).strip("._-")
    return (cleaned[:120] or fallback)


def _trim(value: object, limit: int = 2048) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _extract_gdb_archive(archive: Path, destination: Path) -> Path:
    try:
        with zipfile.ZipFile(archive) as source:
            for info in source.infolist():
                raw_name = info.filename.replace("\\", "/")
                if not raw_name or raw_name.endswith("/"):
                    continue
                parts = [part for part in PurePosixPath(raw_name).parts if part not in {"", "."}]
                if not parts or ".." in parts:
                    raise ValueError("The source GDB archive contains an unsafe path")
                target = destination.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(info) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
    except zipfile.BadZipFile as exc:
        raise ValueError("The stored survey file is not a valid ZIP archive") from exc

    candidates = sorted(
        (path for path in destination.rglob("*") if path.is_dir() and path.suffix.casefold() == ".gdb"),
        key=lambda path: len(path.parts),
    )
    if not candidates:
        raise ValueError("The stored survey ZIP does not contain a File Geodatabase")
    return candidates[0]


def _write_updated_gdb(
    source_gdb: Path,
    output_gdb: Path,
    records: Iterable[ResolvedGdbRecord],
) -> int:
    if pyogrio.list_drivers().get("OpenFileGDB") not in {"rw", "w"}:
        raise ValueError("This server's GDAL build cannot write OpenFileGDB datasets")

    by_layer_fid: dict[tuple[str, str], ResolvedGdbRecord] = {}
    for record in records:
        key = (record.source_layer.casefold(), _normalise_fid(record.source_fid))
        if key[1]:
            by_layer_fid[key] = record

    layers = list(pyogrio.list_layers(source_gdb))
    if not layers:
        raise ValueError("The source File Geodatabase contains no readable layers")

    updated = 0
    first_layer = True
    for layer_name, _geometry_type in layers:
        frame = gpd.read_file(
            source_gdb,
            layer=str(layer_name),
            engine="pyogrio",
            fid_as_index=True,
        )
        source_fids = [_normalise_fid(value) for value in frame.index.to_list()]
        frame = frame.reset_index(drop=True)

        # Stable source identity is retained even when the destination GDB
        # assigns a different internal ObjectID during rewrite.
        frame["SOURCE_FID"] = source_fids
        audit_fields = {
            "FEATURE_UUID": None,
            "AI_FINDING_ID": None,
            "ORIGINAL_CONDITION": None,
            "VERIFIED_CONDITION": None,
            "RESOLUTION_STATUS": None,
            "ARCHITECT_NAME": None,
            "WORK_COMPLETED": None,
            "WORK_COMPLETED_DATE": None,
            "ADMIN_NAME": None,
            "ADMIN_APPROVAL_DATE": None,
            "ADMIN_REMARKS": None,
            "LOCATION_STATUS": None,
            "EVIDENCE_REFERENCE": None,
        }
        for field_name, default in audit_fields.items():
            if field_name not in frame.columns:
                frame[field_name] = default

        condition_column = next(
            (column for column in frame.columns if str(column).casefold() == "condition"),
            None,
        )
        if condition_column is None:
            condition_column = "Condition"
            frame[condition_column] = None

        for row_index, source_fid in enumerate(source_fids):
            record = by_layer_fid.get((str(layer_name).casefold(), source_fid))
            if record is None:
                continue
            current_source_condition = _trim(frame.at[row_index, condition_column], 128)
            original_condition = record.original_condition or current_source_condition
            verified_title = record.verified_condition.strip().title()

            frame.at[row_index, "FEATURE_UUID"] = record.feature_id
            frame.at[row_index, "AI_FINDING_ID"] = record.anomaly_id
            frame.at[row_index, "ORIGINAL_CONDITION"] = _trim(original_condition, 128)
            frame.at[row_index, "VERIFIED_CONDITION"] = verified_title
            frame.at[row_index, "RESOLUTION_STATUS"] = "RESOLVED_APPROVED"
            frame.at[row_index, "ARCHITECT_NAME"] = _trim(record.architect_name, 255)
            frame.at[row_index, "WORK_COMPLETED"] = _trim(record.work_completed, 4000)
            frame.at[row_index, "WORK_COMPLETED_DATE"] = _iso(record.work_completed_at)
            frame.at[row_index, "ADMIN_NAME"] = _trim(record.admin_name, 255)
            frame.at[row_index, "ADMIN_APPROVAL_DATE"] = _iso(record.resolved_at)
            frame.at[row_index, "ADMIN_REMARKS"] = _trim(record.admin_remarks, 4000)
            frame.at[row_index, "LOCATION_STATUS"] = _trim(record.location_status, 64)
            frame.at[row_index, "EVIDENCE_REFERENCE"] = (
                f"/api/v1/point-verifications/evidence/{record.verification_id}/after"
            )
            # This is the generated resolved copy, so its current Condition is
            # updated while ORIGINAL_CONDITION preserves the survey value.
            frame.at[row_index, condition_column] = verified_title
            updated += 1

        pyogrio.write_dataframe(
            frame,
            output_gdb,
            layer=str(layer_name),
            driver="OpenFileGDB",
            append=not first_layer,
        )
        first_layer = False

    return updated


def _zip_gdb(output_gdb: Path, archive: Path) -> None:
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as bundle:
        for path in sorted(output_gdb.rglob("*")):
            if not path.is_file() or path.name.casefold().endswith(".sr.lock"):
                continue
            bundle.write(path, arcname=path.relative_to(output_gdb.parent).as_posix())


async def generate_resolved_gdb(
    dataset: Dataset,
    records: list[ResolvedGdbRecord],
) -> tuple[Path, Path, str, int]:
    if not dataset.storage_key:
        raise ValueError("This dataset has no stored source file")
    if not records:
        raise ValueError("No Admin-approved resolved features exist for this dataset")

    root = Path(tempfile.mkdtemp(prefix="resolved-gdb-export-"))
    source_archive = root / "source.zip"
    extracted = root / "source"
    extracted.mkdir(parents=True, exist_ok=True)
    await download_to_file(dataset.storage_key, source_archive)

    source_gdb = await asyncio.to_thread(_extract_gdb_archive, source_archive, extracted)
    base_name = _safe_component(source_gdb.stem or dataset.name, "survey")
    output_name = f"{base_name}_UPDATED_RESOLVED.gdb"
    output_gdb = root / output_name
    updated = await asyncio.to_thread(_write_updated_gdb, source_gdb, output_gdb, records)
    if updated == 0:
        shutil.rmtree(root, ignore_errors=True)
        raise ValueError(
            "Approved records could not be matched to source GDB rows. Check gdb_layer and FID preservation."
        )

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    archive_name = f"{base_name}_UPDATED_RESOLVED_{stamp}.gdb.zip"
    archive = root / archive_name
    await asyncio.to_thread(_zip_gdb, output_gdb, archive)
    return archive, root, archive_name, updated

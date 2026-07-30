from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.api.v1.public_datasets import (
    _safe_upload_filename,
    _validate_public_vector_file,
)
from app.services.public_dataset_ingestion import _gdb_entry_path


def _zip_bytes(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def test_windows_upload_path_is_reduced_to_filename() -> None:
    assert _safe_upload_filename(r"C:\survey\Ward12.gdb.zip") == "Ward12.gdb.zip"


def test_complete_shapefile_zip_is_accepted() -> None:
    payload = _zip_bytes(
        {
            "roads.shp": b"placeholder",
            "roads.dbf": b"placeholder",
            "roads.shx": b"placeholder",
            "roads.prj": b"GEOGCS placeholder",
        }
    )
    _validate_public_vector_file("roads.zip", payload)


def test_nested_single_gdb_zip_is_accepted_and_resolved(tmp_path: Path) -> None:
    payload = _zip_bytes(
        {
            "delivery/Davangere.gdb/a00000001.gdbtable": b"table",
            "delivery/Davangere.gdb/gdb": b"metadata",
        }
    )
    _validate_public_vector_file("Davangere.zip", payload)
    archive_path = tmp_path / "Davangere.zip"
    archive_path.write_bytes(payload)
    assert _gdb_entry_path(archive_path) == "delivery/Davangere.gdb"


def test_multiple_gdb_folders_are_rejected() -> None:
    payload = _zip_bytes(
        {
            "one.gdb/a.gdbtable": b"one",
            "two.gdb/b.gdbtable": b"two",
        }
    )
    with pytest.raises(HTTPException) as exc_info:
        _validate_public_vector_file("two-gdbs.zip", payload)
    assert exc_info.value.status_code == 400
    assert "only one File Geodatabase" in str(exc_info.value.detail)


def test_unsafe_zip_path_is_rejected() -> None:
    payload = _zip_bytes(
        {
            "../escape.gdb/a.gdbtable": b"bad",
        }
    )
    with pytest.raises(HTTPException) as exc_info:
        _validate_public_vector_file("unsafe.zip", payload)
    assert exc_info.value.status_code == 400
    assert "unsafe file path" in str(exc_info.value.detail)


def test_unsupported_public_dataset_extension_is_rejected() -> None:
    with pytest.raises(HTTPException) as exc_info:
        _validate_public_vector_file("cloud.laz", b"LASF")
    assert exc_info.value.status_code == 400
    assert "Public map uploads support" in str(exc_info.value.detail)

"""
The `DatasetReader` protocol.

Every ingestion strategy (Shapefile / GeoJSON / CSV / XLSX / …) implements
this interface.  The dispatcher (`registry.get_reader_for`) walks the list
of concrete readers and returns the first whose `can_handle()` returns
True for the given filename.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable


@dataclass(slots=True, frozen=True)
class ReaderResult:
    """Summary returned by a reader after it finishes processing a file."""

    inserted: int
    skipped: int
    source_crs: str | None
    notes: str | None = None
    # Set by RasterReader: a rendered preview image of the full raster
    # (reprojected to EPSG:4326) so the map can show actual imagery
    # instead of sampled points — {"image_key": str, "bounds": [w,s,e,n]}.
    raster_overlay: dict | None = None
    # Set by ObjReader when the upload was a zip bundle (.obj + .mtl +
    # textures) rather than a bare .obj — lets the 3D viewer fetch the real
    # materials/textures instead of falling back to a flat placeholder color.
    # {"obj_key": str, "obj_filename": str, "mtl_key": str|None,
    #  "mtl_filename": str|None, "textures": {filename: storage_key}}
    model_assets: dict | None = None
    # Reader-specific structured metadata promoted onto Dataset.metadata
    # (e.g. {"model_3d": {...}}) — keeps format details such as an OBJ
    # model's source CRS available to the UI (DataSourceSelector) beyond
    # the raw asset pointers in `model_assets`.
    dataset_metadata: dict | None = None


@runtime_checkable
class DatasetReader(Protocol):
    """Strategy interface for turning an uploaded file into `features` rows."""

    def can_handle(self, filename: str) -> bool:  # pragma: no cover - protocol
        ...

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:  # pragma: no cover
        ...

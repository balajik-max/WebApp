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
    # Reader-specific metadata promoted onto Dataset.metadata. This keeps
    # format details such as an OBJ model's CRS/origin available to the UI.
    dataset_metadata: dict | None = None


@runtime_checkable
class DatasetReader(Protocol):
    """Strategy interface for turning an uploaded file into `features` rows."""

    def can_handle(self, filename: str) -> bool:  # pragma: no cover - protocol
        ...

    async def read(self, file_path: Path, dataset_id: str) -> ReaderResult:  # pragma: no cover
        ...
